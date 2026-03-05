const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

// --------------------------------------------------------
// FUNZIONI DI SUPPORTO E BYPASS SICUREZZA
// --------------------------------------------------------

const defaultHeaders = { 
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache'
};

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

function extractPriceRegex(html) {
    if (!html) return null;
    const match = html.match(/"(?:lastPrice|price|regularMarketPrice|ask|nav|close|Prezzo)"\s*[:=]\s*"?(\d+(?:\.\d+)?)/i);
    if (match && match[1]) {
        return parseFloat(match[1]);
    }
    return null;
}

// IL NUOVO SISTEMA ANTI-CLOUDFLARE: Rotazione Proxy Infallibile
async function fetchHtml(targetUrl) {
    const proxies = [
        targetUrl, // 1. Tentativo Diretto
        `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`, // 2. Proxy AllOrigins
        `https://corsproxy.io/?${encodeURIComponent(targetUrl)}` // 3. Proxy CorsProxy
    ];

    for (let url of proxies) {
        try {
            const res = await axios.get(url, { headers: defaultHeaders, timeout: 8000 });
            const html = res.data;
            
            // Controlliamo se ci hanno mandato una pagina di blocco Anti-Bot. Se sì, scartiamola e usiamo il prossimo proxy.
            if (typeof html === 'string') {
                if (html.includes('Just a moment...') || 
                    html.includes('Enable JavaScript and cookies to continue') ||
                    (html.includes('Cloudflare') && html.includes('captcha'))) {
                    continue; 
                }
                return html; // Abbiamo ottenuto la pagina vera!
            }
        } catch (err) {
            // Se c'è un errore (es. 403 Forbidden), passiamo silenziosamente al prossimo proxy
            continue; 
        }
    }
    return null; // Tutti i tentativi hanno fallito
}

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

    if (ticker) {
        const price = await getYahooPrice(ticker);
        if (price) return res.json({ price, source: 'Yahoo Finance (Ticker)' });
        logs.push(`Ticker non trovato su Yahoo: ${ticker}`);
    }

    if (isin) {
        const cleanIsin = isin.trim().toUpperCase();

        try {
            const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${cleanIsin}`;
            const searchRes = await axios.get(searchUrl, { headers: defaultHeaders, timeout: 5000 });
            if (searchRes.data.quotes && searchRes.data.quotes.length > 0) {
                const validQuote = searchRes.data.quotes.find(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF' || q.quoteType === 'MUTUALFUND') || searchRes.data.quotes[0];
                if (validQuote && validQuote.symbol) {
                    const price = await getYahooPrice(validQuote.symbol);
                    if (price) return res.json({ price, source: `Yahoo Finance (${validQuote.symbol})` });
                }
            }
        } catch (e) {
            logs.push('Traduzione Yahoo ISIN fallita');
        }

        try {
            const html = await fetchHtml(`https://www.justetf.com/it/etf-profile.html?isin=${cleanIsin}`);
            if (html) {
                const $ = cheerio.load(html);
                let priceText = $('.val span').first().text() || $('.infobox .val').first().text() || $('div[class*="val"] span').first().text();
                let price = parseEuroPrice(priceText);
                
                if (!isNaN(price) && price > 0) return res.json({ price, source: 'JustETF (HTML)' });

                price = extractPriceRegex(html);
                if (price) return res.json({ price, source: 'JustETF (Codice Nascosto)' });
            }
            logs.push('Prezzo non trovato su JustETF (Blocco Anti-Bot in corso)');
        } catch(e) { logs.push('JustETF fallito'); }

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
            logs.push('Prezzo non trovato su Borsa Italiana (Blocco Anti-Bot in corso)');
        } catch(e) { logs.push('Borsa Italiana fallita'); }

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
            logs.push('Prezzo non trovato su Teleborsa (Blocco Anti-Bot in corso)');
        } catch(e) { logs.push('Teleborsa fallita'); }
        
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

    res.status(404).json({ error: 'Prezzo non trovato con nessun metodo', logs });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server API & Scraping in ascolto sulla porta ${PORT}`);
});
