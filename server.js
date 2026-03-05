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

    // Headers standard per simulare un browser reale
    const headers = { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/json,application/xhtml+xml',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    };

    // 1. TENTATIVO DIRETTO: YAHOO FINANCE (Se hai inserito il Ticker a mano)
    if (ticker) {
        try {
            const price = await getYahooPrice(ticker, headers);
            if (price) return res.json({ price, source: 'Yahoo Finance (Ticker)' });
        } catch (e) {
            console.log(`Yahoo API fallito per ticker: ${ticker}`);
        }
    }

    // 2. CASCATA DI RICERCA TRAMITE ISIN
    if (isin) {
        const cleanIsin = isin.trim().toUpperCase();

        // 2A. Traduzione ISIN in Ticker (Trucchetto infallibile per Azioni Italiane come ENI)
        try {
            const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${cleanIsin}`;
            const searchRes = await axios.get(searchUrl, { headers, timeout: 5000 });
            if (searchRes.data.quotes && searchRes.data.quotes.length > 0) {
                // Prende il primo Ticker trovato corrispondente a quell'ISIN
                const foundTicker = searchRes.data.quotes[0].symbol;
                const price = await getYahooPrice(foundTicker, headers);
                if (price) return res.json({ price, source: `Yahoo Finance (Via ISIN: ${foundTicker})` });
            }
        } catch (e) {
            console.log(`Ricerca Yahoo fallita per ISIN: ${cleanIsin}`);
        }

        // 2B. TENTATIVO TELEBORSA (Raccoglie Borsa Italiana, BTP e Certificati Vontobel)
        try {
            const tUrl = `https://www.teleborsa.it/Quotazioni/Ricerca?q=${cleanIsin}`;
            const { data } = await axios.get(tUrl, { headers, timeout: 8000 });
            const $ = cheerio.load(data);
            
            // Cerchiamo le classi CSS dove Teleborsa posiziona i prezzi
            let priceText = $('span.t-text-3xl').first().text().trim() || 
                            $('span.t-text-2xl').first().text().trim() ||
                            $('.m-box-titolo-dettaglio-prezzo').first().text().trim();
            
            if (priceText) {
                // Pulisce il formato europeo "1.234,56 €" in "1234.56"
                priceText = priceText.replace('€', '').replace(/\./g, '').replace(',', '.').trim();
                const price = parseFloat(priceText);
                if (!isNaN(price) && price > 0) return res.json({ price, source: 'Teleborsa' });
            }
        } catch(e) {
            console.log(`Teleborsa fallito per ISIN: ${cleanIsin}`);
        }

        // 2C. TENTATIVO JUSTETF (Il migliore per gli ETF non coperti da Yahoo)
        try {
            const jUrl = `https://www.justetf.com/it/etf-profile.html?isin=${cleanIsin}`;
            const { data } = await axios.get(jUrl, { headers, timeout: 8000 });
            const $ = cheerio.load(data);
            
            const priceText = $('.val span').first().text().trim().replace(',', '.');
            const price = parseFloat(priceText);
            
            if (!isNaN(price) && price > 0) return res.json({ price, source: 'JustETF' });
        } catch(e) {
            console.log(`JustETF fallito per ISIN: ${cleanIsin}`);
        }
    }

    // Se tutti i 4 tentativi falliscono, restituisce errore
    res.status(404).json({ error: 'Prezzo non trovato con nessun metodo' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server API & Scraping in ascolto sulla porta ${PORT}`);
});
