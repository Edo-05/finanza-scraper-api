const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

// --------------------------------------------------------
// FUNZIONI DI SUPPORTO E BYPASS SICUREZZA
// --------------------------------------------------------

// Headers globali per simulare un browser reale (FONDAMENTALE per non farsi bloccare da Yahoo e altri)
const defaultHeaders = { 
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
};

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

// "Il Segugio": Cerca valori numerici nascosti nel codice sorgente Javascript (JSON)
function extractPriceRegex(html) {
    if (!html) return null;
    // Cerca pattern comuni usati dalle API interne dei siti (es. "lastPrice":12.34, "price":12.34)
    const match = html.match(/"(?:lastPrice|price|regularMarketPrice|ask|nav|close)"\s*:\s*(\d+(?:\.\d+)?)/i);
    if (match && match[1]) {
        return parseFloat(match[1]);
    }
    return null;
}

// Funzione infallibile che prova la via diretta, e se bloccata usa un proxy
async function fetchHtml(targetUrl) {
    try {
        const res = await axios.get(targetUrl, { headers: defaultHeaders, timeout: 6000 });
        return res.data;
    } catch (err) {
        try {
            const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
            const proxyRes = await axios.get(proxyUrl, { headers: defaultHeaders, timeout: 8000 });
            if (proxyRes.data && proxyRes.data.contents) {
                return proxyRes.data.contents;
            }
        } catch (proxyErr) {
            return null;
        }
    }
    return null;
}

// Interroga l'API di Yahoo (che non blocca mai i server se ha gli headers giusti)
async function getYahooPrice(ticker) {
    try {
        const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
        const { data } = await axios.get(yUrl, { headers: defaultHeaders, timeout: 5000 });
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

    // 1. YAHOO TRAMITE TICKER
    if (ticker) {
        const price = await getYahooPrice(ticker);
        if (price) return res.json({ price, source: 'Yahoo Finance (Ticker)' });
        logs.push(`Ticker non trovato su Yahoo: ${ticker}`);
    }

    if (isin) {
        const cleanIsin = isin.trim().toUpperCase();

        // 2A. TRADUZIONE ISIN -> YAHOO
        try {
            const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${cleanIsin}`;
            // Aggiunti gli header obbligatori per evitare il blocco 403 di Yahoo
            const searchRes = await axios.get(searchUrl, { headers: defaultHeaders, timeout: 5000 });
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

        // 2B. JUSTETF (Scansione Visiva + Scansione Segugio)
        try {
            const html = await fetchHtml(`https://www.justetf.com/it/etf-profile.html?isin=${cleanIsin}`);
            if (html) {
                const $ = cheerio.load(html);
                let priceText = $('.val span').first().text() || $('.infobox .val').first().text() || $('div[class*="val"] span').first().text();
                let price = parseEuroPrice(priceText);
                
                if (!isNaN(price) && price > 0) return res.json({ price, source: 'JustETF (HTML)' });

                // Passaggio del Segugio nel codice grezzo
                price = extractPriceRegex(html);
                if (price) return res.json({ price, source: 'JustETF (Codice Nascosto)' });
            }
            logs.push('Prezzo non trovato su JustETF');
        } catch(e) { logs.push('JustETF fallito'); }

        // 2C. BORSA ITALIANA
        try {
            const html = await fetchHtml(`https://www.borsaitaliana.it/borsa/ricerca/dettaglio.html?isin=${cleanIsin}`);
            if (html) {
                const $ = cheerio.load(html);
                let priceText = $('.summary-value').first().text() || 
                                $('span.-block._dow').first().text() ||
                                $('span.t-text-right').first().text() ||
                                $('.m-box-titolo-dettaglio-prezzo').first().text() ||
                                $('strong.t-text-3xl').first().text();
                let price = parseEuroPrice(priceText);
                
                if (!isNaN(price) && price > 0) return res.json({ price, source: 'Borsa Italiana (HTML)' });

                price = extractPriceRegex(html);
                if (price) return res.json({ price, source: 'Borsa Italiana (Codice Nascosto)' });
            }
            logs.push('Prezzo non trovato su Borsa Italiana');
        } catch(e) { logs.push('Borsa Italiana fallita'); }

        // 2D. TELEBORSA (Ottimo Paracadute per ETF e BTP)
        try {
            const html = await fetchHtml(`https://www.teleborsa.it/Quotazioni/Ricerca?q=${cleanIsin}`);
            if (html) {
                const $ = cheerio.load(html);
                let priceText = $('span.t-text-3xl').first().text() || 
                                $('span[class*="text-3xl"]').first().text() ||
                                $('span.t-text-2xl').first().text() ||
                                $('.m-box-titolo-dettaglio-prezzo').first().text();
                let price = parseEuroPrice(priceText);
                
                if (!isNaN(price) && price > 0) return res.json({ price, source: 'Teleborsa (HTML)' });

                price = extractPriceRegex(html);
                if (price) return res.json({ price, source: 'Teleborsa (Codice Nascosto)' });
            }
            logs.push('Prezzo non trovato su Teleborsa');
        } catch(e) { logs.push('Teleborsa fallita'); }
        
        // 2E. MARKETS VONTOBEL (Certificati Vontobel)
        try {
            const html = await fetchHtml(`https://markets.vontobel.com/it-it/prodotti/ricerca?query=${cleanIsin}`);
            if (html) {
                const $ = cheerio.load(html);
                let priceText = $('.ask-price').first().text() || 
                                $('.price-value').first().text() || 
                                $('td.ask span.value').first().text() ||
                                $('td[data-col="ask"]').first().text() ||
                                $('.product-price').first().text();
                let price = parseEuroPrice(priceText);
                
                if (!isNaN(price) && price > 0) return res.json({ price, source: 'Markets Vontobel (HTML)' });

                price = extractPriceRegex(html);
                if (price) return res.json({ price, source: 'Markets Vontobel (Codice Nascosto)' });
            }
            logs.push('Prezzo non trovato su Vontobel');
        } catch(e) { logs.push('Vontobel fallita'); }
    }

    // Se arriviamo qui, il segugio non ce l'ha fatta su nessun sito
    res.status(404).json({ error: 'Prezzo non trovato con nessun metodo', logs });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server API & Scraping in ascolto sulla porta ${PORT}`);
});
