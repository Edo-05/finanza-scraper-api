const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

// Headers per simulare un browser reale ed evitare blocchi
const defaultHeaders = { 
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, come Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Connection': 'keep-alive'
};

// Pulisce qualsiasi formato valuta (es. "€ 1.234,56" -> 1234.56)
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

app.get('/api/price', async (req, res) => {
    const { ticker, isin } = req.query;
    let logs = []; 

    // 1. YAHOO FINANCE (Tramite Ticker diretto)
    if (ticker) {
        try {
            const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
            const { data } = await axios.get(yUrl, { headers: defaultHeaders, timeout: 5000 });
            if (data.chart && data.chart.result && data.chart.result.length > 0) {
                const price = data.chart.result[0].meta.regularMarketPrice;
                if (price) return res.json({ price, source: 'Yahoo Finance' });
            }
        } catch(e) { logs.push('Yahoo Ticker fallito'); }
    }

    if (isin) {
        const cleanIsin = isin.trim().toUpperCase();

        // 2. IL SOLE 24 ORE (Borsa Italiana / BTP / Azioni ITA)
        // Usiamo la loro API interna che è molto più affidabile dello scraping
        try {
            const soleUrl = `https://mercati.ilsole24ore.com/api/proxy/dati/strumento?isin=${cleanIsin}`;
            const soleRes = await axios.get(soleUrl, { headers: defaultHeaders, timeout: 5000 });
            if (soleRes.data && soleRes.data.Prezzo) {
                const price = parseEuroPrice(soleRes.data.Prezzo);
                if (!isNaN(price) && price > 0) return res.json({ price, source: 'Sole 24 Ore API' });
            }
        } catch(e) { logs.push('Sole 24 Ore fallito'); }

        // 3. FINANCIAL TIMES (ETF / Fondi / Titoli Esteri)
        try {
            const ftSearchUrl = `https://markets.ft.com/data/searchapi/search?query=${cleanIsin}`;
            const ftSearchRes = await axios.get(ftSearchUrl, { headers: defaultHeaders, timeout: 5000 });
            if (ftSearchRes.data?.data?.searchResults?.length > 0) {
                const ftSymbol = ftSearchRes.data.data.searchResults[0].symbol;
                const ftQuoteUrl = `https://markets.ft.com/data/extapi/quotes?symbols=${ftSymbol}`;
                const ftQuoteRes = await axios.get(ftQuoteUrl, { headers: defaultHeaders, timeout: 5000 });
                if (ftQuoteRes.data?.length > 0) {
                    const price = ftQuoteRes.data[0].lastPrice;
                    if (price) return res.json({ price: parseFloat(price), source: 'Financial Times API' });
                }
            }
        } catch(e) { logs.push('Financial Times fallito'); }

        // 4. TELEBORSA (Certificati Vontobel / Altri Certificati / BTP)
        // Teleborsa non blocca i server e ha dati molto puliti
        try {
            const tUrl = `https://www.teleborsa.it/Quotazioni/Ricerca?q=${cleanIsin}`;
            const tRes = await axios.get(tUrl, { headers: defaultHeaders, timeout: 6000 });
            // Cerchiamo il prezzo nell'HTML con una regex che punta alla classe del prezzo
            const match = tRes.data.match(/<span[^>]*class="[^"]*t-text-3xl[^"]*"[^>]*>([\d,.]+)<\/span>/i) || 
                          tRes.data.match(/<span[^>]*class="[^"]*t-text-2xl[^"]*"[^>]*>([\d,.]+)<\/span>/i);
            if (match && match[1]) {
                const price = parseEuroPrice(match[1]);
                if (!isNaN(price) && price > 0) return res.json({ price, source: 'Teleborsa' });
            }
        } catch(e) { logs.push('Teleborsa fallito'); }

        // 5. YAHOO SEARCH (Ultima spiaggia: prova a convertire ISIN in Ticker)
        try {
            const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${cleanIsin}`;
            const searchRes = await axios.get(searchUrl, { headers: defaultHeaders, timeout: 5000 });
            if (searchRes.data.quotes?.length > 0) {
                const symbol = searchRes.data.quotes[0].symbol;
                const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
                const yRes = await axios.get(yUrl, { headers: defaultHeaders, timeout: 5000 });
                if (yRes.data.chart?.result?.length > 0) {
                    const price = yRes.data.chart.result[0].meta.regularMarketPrice;
                    if (price) return res.json({ price, source: 'Yahoo (via ISIN)' });
                }
            }
        } catch(e) { logs.push('Yahoo ISIN fallito'); }
    }

    res.status(404).json({ error: 'Prezzo non trovato', logs });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server API & Scraping attivo sulla porta ${PORT}`);
});
