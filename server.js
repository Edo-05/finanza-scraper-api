const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

// Funzione di supporto per interrogare Yahoo Finance tramite Ticker
async function getYahooPrice(ticker, headers) {
    const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const { data } = await axios.get(yUrl, { headers, timeout: 5000 });
    if (data.chart.result && data.chart.result.length > 0) {
        const price = data.chart.result[0].meta.regularMarketPrice;
        if (price) return price;
    }
    return null;
}

app.get('/api/price', async (req, res) => {
    const { ticker, isin } = req.query;
    let logs = []; // Teniamo traccia di cosa succede

    // Headers per simulare un vero browser
    const headers = { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache'
    };

    // 1. TENTATIVO DIRETTO: YAHOO FINANCE (Se hai inserito il Ticker)
    if (ticker) {
        try {
            const price = await getYahooPrice(ticker, headers);
            if (price) return res.json({ price, source: 'Yahoo Finance (Ticker)' });
            logs.push(`Yahoo (Ticker): Prezzo non trovato per ${ticker}`);
        } catch (e) {
            logs.push(`Yahoo (Ticker) fallito: ${e.message}`);
        }
    }

    // 2. CASCATA DI RICERCA TRAMITE ISIN
    if (isin) {
        const cleanIsin = isin.trim().toUpperCase();

        // 2A. TRADUZIONE ISIN -> TICKER YAHOO (Ottimo per Azioni normali)
        try {
            const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${cleanIsin}`;
            const searchRes = await axios.get(searchUrl, { headers, timeout: 5000 });
            if (searchRes.data.quotes && searchRes.data.quotes.length > 0) {
                const validQuote = searchRes.data.quotes.find(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF') || searchRes.data.quotes[0];
                if (validQuote && validQuote.symbol) {
                    const price = await getYahooPrice(validQuote.symbol, headers);
                    if (price) return res.json({ price, source: `Yahoo Finance (Convertito da ISIN: ${validQuote.symbol})` });
                }
            }
            logs.push(`Yahoo (ISIN): Nessun ticker associato trovato`);
        } catch (e) {
            logs.push(`Yahoo (ISIN) fallito: ${e.message}`);
        }

        // 2B. BORSA ITALIANA (BTP, BOT, Azioni ITA)
        try {
            const bUrl = `https://www.borsaitaliana.it/borsa/ricerca/dettaglio.html?isin=${cleanIsin}`;
            const { data } = await axios.get(bUrl, { headers, timeout: 8000 });
            const $ = cheerio.load(data);
            
            let priceText = $('.summary-value').first().text() || 
                            $('span.-block._dow').first().text() ||
                            $('span.t-text-right').first().text() ||
                            $('.m-box-titolo-dettaglio-prezzo').first().text();
            
            if (priceText && priceText.trim() !== '') {
                priceText = priceText.replace(/EUR/ig, '').replace(/€/g, '').replace(/\./g, '').replace(',', '.').trim();
                const price = parseFloat(priceText);
                if (!isNaN(price) && price > 0) return res.json({ price, source: 'Borsa Italiana' });
            } else {
                logs.push(`Borsa Italiana: Prezzo non trovato nel codice HTML della pagina`);
            }
        } catch(e) {
            logs.push(`Borsa Italiana fallita: ${e.message}`);
        }

        // 2C. MARKETS VONTOBEL (Certificati)
        try {
            const vUrl = `https://markets.vontobel.com/it-it/prodotti/ricerca?query=${cleanIsin}`;
            const { data } = await axios.get(vUrl, { headers, timeout: 8000 });
            const $ = cheerio.load(data);
            
            let priceText = $('.ask-price').first().text() || 
                            $('.price-value').first().text() || 
                            $('td[data-col="ask"]').first().text();

            if (priceText && priceText.trim() !== '') {
                priceText = priceText.replace(/EUR/ig, '').replace(/€/g, '').replace(/\./g, '').replace(',', '.').trim();
                const price = parseFloat(priceText);
                if (!isNaN(price) && price > 0) return res.json({ price, source: 'Markets Vontobel' });
            } else {
                logs.push(`Vontobel: Prezzo non trovato nel codice HTML della pagina`);
            }
        } catch(e) {
            logs.push(`Vontobel fallita: ${e.message}`);
        }

        // 2D. JUSTETF (Con sistema anti-blocco Proxy Fallback)
        try {
            const jUrl = `https://www.justetf.com/it/etf-profile.html?isin=${cleanIsin}`;
            let response = await axios.get(jUrl, { headers, timeout: 8000 }).catch(() => null);
            
            // Se JustETF ci blocca (403 Forbidden), passiamo da un proxy pubblico!
            if (!response || response.status === 403) {
                logs.push(`JustETF ha bloccato la richiesta diretta. Provo con il Proxy...`);
                const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(jUrl)}`;
                const proxyRes = await axios.get(proxyUrl, { headers, timeout: 10000 });
                if (proxyRes.data && proxyRes.data.contents) {
                    response = { data: proxyRes.data.contents };
                }
            }

            if (response && response.data) {
                const $ = cheerio.load(response.data);
                const priceText = $('.val span').first().text();
                if (priceText && priceText.trim() !== '') {
                    const price = parseFloat(priceText.replace(',', '.'));
                    if (!isNaN(price) && price > 0) return res.json({ price, source: 'JustETF' });
                } else {
                    logs.push(`JustETF: Prezzo non trovato nel codice HTML della pagina`);
                }
            }
        } catch(e) {
            logs.push(`JustETF fallita: ${e.message}`);
        }
    }

    // Niente ha funzionato, restituisci l'errore e tutti i log per capire cosa è andato storto
    res.status(404).json({ error: 'Prezzo non trovato', logs });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server API & Scraping in ascolto sulla porta ${PORT}`);
});
