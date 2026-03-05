const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

// --------------------------------------------------------
// FUNZIONI DI SUPPORTO E BYPASS SICUREZZA
// --------------------------------------------------------

// Pulisce testi complessi (es. "€ 1.234,56", "1,234.56 EUR") in numero puro (1234.56)
function parseEuroPrice(text) {
    if (!text) return NaN;
    let cleaned = text.replace(/[^0-9,.]/g, '');
    if (cleaned.includes('.') && cleaned.includes(',')) {
        if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
            cleaned = cleaned.replace(/\./g, '').replace(',', '.');
        } else {
            cleaned = cleaned.replace(/,/g, '');
        }
    } else if (cleaned.includes(',')) {
        cleaned = cleaned.replace(',', '.');
    }
    return parseFloat(cleaned);
}

// Funzione infallibile che prova la via diretta, e se bloccata usa un proxy
async function fetchHtml(targetUrl) {
    const headers = { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, come Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8'
    };
    try {
        // Tentativo 1: Connessione Diretta
        const res = await axios.get(targetUrl, { headers, timeout: 6000 });
        return res.data;
    } catch (err) {
        // Tentativo 2: Connessione tramite Proxy Pubblico (Aggira Cloudflare)
        try {
            const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
            const proxyRes = await axios.get(proxyUrl, { headers, timeout: 8000 });
            if (proxyRes.data && proxyRes.data.contents) {
                return proxyRes.data.contents;
            }
        } catch (proxyErr) {
            return null;
        }
    }
    return null;
}

// Interroga l'API di Yahoo (che non blocca mai i server)
async function getYahooPrice(ticker) {
    try {
        const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
        const { data } = await axios.get(yUrl, { timeout: 5000 });
        if (data.chart.result && data.chart.result.length > 0) {
            return data.chart.result[0].meta.regularMarketPrice;
        }
    } catch(e) {}
    return null;
}

// --------------------------------------------------------
// ROTTA PRINCIPALE API
// --------------------------------------------------------

app.get('/api/price', async (req, res) => {
    const { ticker, isin } = req.query;
    let logs = []; 

    // 1. YAHOO TRAMITE TICKER (Azioni USA/EU)
    if (ticker) {
        const price = await getYahooPrice(ticker);
        if (price) return res.json({ price, source: 'Yahoo Finance (Ticker)' });
        logs.push(`Ticker non trovato su Yahoo: ${ticker}`);
    }

    if (isin) {
        const cleanIsin = isin.trim().toUpperCase();

        // 2A. TRADUZIONE ISIN -> YAHOO (Perfetto per ENI, Intesa, ecc.)
        try {
            const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${cleanIsin}`;
            const searchRes = await axios.get(searchUrl, { timeout: 5000 });
            if (searchRes.data.quotes && searchRes.data.quotes.length > 0) {
                const validQuote = searchRes.data.quotes.find(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF') || searchRes.data.quotes[0];
                if (validQuote && validQuote.symbol) {
                    const price = await getYahooPrice(validQuote.symbol);
                    if (price) return res.json({ price, source: `Yahoo Finance (${validQuote.symbol})` });
                }
            }
        } catch (e) {
            logs.push('Traduzione Yahoo ISIN fallita');
        }

        // 2B. JUSTETF (Perfetto per ETF e ETC europei)
        try {
            const html = await fetchHtml(`https://www.justetf.com/it/etf-profile.html?isin=${cleanIsin}`);
            if (html) {
                const $ = cheerio.load(html);
                let priceText = $('.val span').first().text() || $('.infobox .val').first().text();
                const price = parseEuroPrice(priceText);
                if (!isNaN(price) && price > 0) return res.json({ price, source: 'JustETF' });
            }
            logs.push('Prezzo non trovato su JustETF');
        } catch(e) { logs.push('JustETF fallito'); }

        // 2C. BORSA ITALIANA (Azioni Italiane, BTP, BOT, Obbligazioni)
        try {
            const html = await fetchHtml(`https://www.borsaitaliana.it/borsa/ricerca/dettaglio.html?isin=${cleanIsin}`);
            if (html) {
                const $ = cheerio.load(html);
                let priceText = $('.summary-value').first().text() || 
                                $('span.-block._dow').first().text() ||
                                $('span.t-text-right').first().text() ||
                                $('.m-box-titolo-dettaglio-prezzo').first().text() ||
                                $('strong.t-text-3xl').first().text();
                const price = parseEuroPrice(priceText);
                if (!isNaN(price) && price > 0) return res.json({ price, source: 'Borsa Italiana' });
            }
            logs.push('Prezzo non trovato su Borsa Italiana (Possibile blocco HTML o classe cambiata)');
        } catch(e) { logs.push('Borsa Italiana fallita'); }

        // 2D. MARKETS VONTOBEL (Certificati Vontobel)
        try {
            const html = await fetchHtml(`https://markets.vontobel.com/it-it/prodotti/ricerca?query=${cleanIsin}`);
            if (html) {
                const $ = cheerio.load(html);
                let priceText = $('.ask-price').first().text() || 
                                $('.price-value').first().text() || 
                                $('td.ask span.value').first().text() ||
                                $('td[data-col="ask"]').first().text() ||
                                $('.product-price').first().text();
                const price = parseEuroPrice(priceText);
                if (!isNaN(price) && price > 0) return res.json({ price, source: 'Markets Vontobel' });
            }
            logs.push('Prezzo non trovato su Vontobel (Il sito potrebbe usare Javascript dinamico)');
        } catch(e) { logs.push('Vontobel fallita'); }

        // 2E. PARACADUTE: TELEBORSA (Risolve il 99% dei problemi se Borsa/Vontobel bloccano)
        try {
            const html = await fetchHtml(`https://www.teleborsa.it/Quotazioni/Ricerca?q=${cleanIsin}`);
            if (html) {
                const $ = cheerio.load(html);
                let priceText = $('span.t-text-3xl').first().text() || 
                                $('span.t-text-2xl').first().text() ||
                                $('.m-box-titolo-dettaglio-prezzo').first().text();
                const price = parseEuroPrice(priceText);
                if (!isNaN(price) && price > 0) return res.json({ price, source: 'Teleborsa' });
            }
            logs.push('Prezzo non trovato su Teleborsa');
        } catch(e) { logs.push('Teleborsa fallita'); }
    }

    // Se arriviamo qui, l'estrattore non ce l'ha fatta su nessun sito
    res.status(404).json({ error: 'Prezzo non trovato con nessun metodo', logs });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server API & Scraping in ascolto sulla porta ${PORT}`);
});
