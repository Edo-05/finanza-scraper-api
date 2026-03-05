const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

// Headers standard per sembrare un'app legittima
const defaultHeaders = { 
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, come Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Connection': 'keep-alive'
};

// Pulisce qualsiasi formato valuta in un numero pulito
function parseEuroPrice(text) {
    if (!text) return NaN;
    let cleaned = text.toString().replace(/[^0-9,.]/g, '');
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

// FUNZIONE SCUDO: Usa un proxy per nascondere l'identità del server Render ed evitare blocchi IP
async function fetchProxied(url, isJson = true) {
    try {
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
        const response = await axios.get(proxyUrl, { timeout: 10000 });
        if (response.data && response.data.contents) {
            if (isJson) {
                return JSON.parse(response.data.contents);
            } else {
                return response.data.contents;
            }
        }
    } catch (e) {
        console.error("Errore proxy per", url);
    }
    return null;
}

app.get('/api/price', async (req, res) => {
    const { ticker, isin } = req.query;
    let logs = []; 

    // 1. YAHOO TRAMITE TICKER (Non necessita di proxy)
    if (ticker) {
        try {
            const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
            const { data } = await axios.get(yUrl, { headers: defaultHeaders, timeout: 5000 });
            if (data.chart.result && data.chart.result.length > 0) {
                const price = data.chart.result[0].meta.regularMarketPrice;
                if (price) return res.json({ price, source: 'Yahoo Finance (Ticker)' });
            }
        } catch(e) { logs.push('Yahoo Ticker fallito'); }
    }

    if (isin) {
        const cleanIsin = isin.trim().toUpperCase();

        // 2A. YAHOO SEARCH (Traduzione ISIN)
        try {
            const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${cleanIsin}`;
            const searchRes = await axios.get(searchUrl, { headers: defaultHeaders, timeout: 5000 });
            if (searchRes.data.quotes && searchRes.data.quotes.length > 0) {
                const validQuote = searchRes.data.quotes.find(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF' || q.quoteType === 'MUTUALFUND') || searchRes.data.quotes[0];
                if (validQuote && validQuote.symbol) {
                    const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(validQuote.symbol)}?interval=1d&range=1d`;
                    const yRes = await axios.get(yUrl, { headers: defaultHeaders, timeout: 5000 });
                    if (yRes.data.chart.result && yRes.data.chart.result.length > 0) {
                        const price = yRes.data.chart.result[0].meta.regularMarketPrice;
                        if (price) return res.json({ price, source: `Yahoo Finance (${validQuote.symbol})` });
                    }
                }
            }
        } catch (e) { logs.push('Yahoo ISIN fallito'); }

        // 2B. FINANCIAL TIMES API (Il Re dei BTP, Fondi Comuni e ETF Europei) TRAMITE PROXY
        try {
            const ftSearchUrl = `https://markets.ft.com/data/searchapi/search?query=${cleanIsin}`;
            const searchData = await fetchProxied(ftSearchUrl, true);
            if (searchData && searchData.data && searchData.data.searchResults && searchData.data.searchResults.length > 0) {
                const ftSymbol = searchData.data.searchResults[0].symbol;
                const ftQuoteUrl = `https://markets.ft.com/data/extapi/quotes?symbols=${ftSymbol}`;
                const quoteData = await fetchProxied(ftQuoteUrl, true);
                if (quoteData && quoteData.length > 0) {
                    const price = quoteData[0].lastPrice;
                    if (price) return res.json({ price: parseFloat(price), source: 'Financial Times API' });
                }
            }
        } catch(e) { logs.push('Financial Times fallito'); }

        // 2C. TRADEGATE EXCHANGE TRAMITE PROXY
        try {
            const tgUrl = `https://www.tradegate.de/refresh.php?isin=${cleanIsin}`;
            const html = await fetchProxied(tgUrl, false);
            if (html) {
                const match = html.match(/<td id="last">([\d,.]+)<\/td>/i);
                if (match && match[1]) {
                    const price = parseEuroPrice(match[1]);
                    if (!isNaN(price) && price > 0) return res.json({ price, source: 'Tradegate Exchange' });
                }
            }
        } catch(e) { logs.push('Tradegate fallito'); }

        // 2D. IL SOLE 24 ORE API TRAMITE PROXY
        try {
            const soleUrl = `https://mercati.ilsole24ore.com/api/proxy/dati/strumento?isin=${cleanIsin}`;
            const soleData = await fetchProxied(soleUrl, true);
            if (soleData && soleData.Prezzo) {
                const price = parseEuroPrice(soleData.Prezzo);
                if (!isNaN(price) && price > 0) return res.json({ price, source: 'Il Sole 24 Ore API' });
            }
        } catch(e) { logs.push('Sole 24 Ore fallito'); }
        
        // 2E. JUSTETF TRAMITE PROXY (HTML)
        try {
            const jUrl = `https://www.justetf.com/it/etf-profile.html?isin=${cleanIsin}`;
            const html = await fetchProxied(jUrl, false);
            if (html) {
                // Estrae il prezzo cercando il tag HTML specifico
                const match = html.match(/<div[^>]*class="[^"]*val[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\d,.]+)<\/span>/i);
                if (match && match[1]) {
                    const price = parseEuroPrice(match[1]);
                    if (!isNaN(price) && price > 0) return res.json({ price, source: 'JustETF' });
                }
            }
        } catch(e) { logs.push('JustETF fallito'); }
    }

    // Se arriviamo qui... l'asset è davvero introvabile!
    res.status(404).json({ error: 'Prezzo non trovato nei database', logs });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server API Attivo sulla porta ${PORT}`);
});
