const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

app.get('/api/price', async (req, res) => {
    const { ticker, isin } = req.query;

    if (ticker) {
        try {
            const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
            const { data } = await axios.get(yUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });

            if (data.chart.result && data.chart.result.length > 0) {
                const price = data.chart.result[0].meta.regularMarketPrice;
                if (price) return res.json({ price, source: 'Yahoo Finance' });
            }
        } catch (e) {
            console.log(`Yahoo API fallito per ticker: ${ticker}`);
        }
    }

    if (isin) {
        try {
            const jUrl = `https://www.justetf.com/it/etf-profile.html?isin=${isin}`;
            const { data } = await axios.get(jUrl, { 
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml'
                } 
            });
            const $ = cheerio.load(data);

            const priceText = $('.val span').first().text().trim().replace(',', '.');
            const price = parseFloat(priceText);

            if (!isNaN(price)) return res.json({ price, source: 'Scraping JustETF' });
        } catch(e) {
            console.log(`Scraping JustETF fallito per ISIN: ${isin}`);
        }
    }

    res.status(404).json({ error: 'Prezzo non trovato con nessun metodo' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server di scraping in ascolto sulla porta ${PORT}`);
});
