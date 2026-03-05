const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

app.get('/api/price', async (req, res) => {
    const { ticker, isin } = req.query;

    // Headers standard per simulare un browser reale (Anti-bot bypass di base)
    const headers = { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    };

    // 1. TENTATIVO: YAHOO FINANCE (Ottimo per Azioni USA/EU e Crypto tramite Ticker)
    if (ticker) {
        try {
            const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
            const { data } = await axios.get(yUrl, { headers });
            
            if (data.chart.result && data.chart.result.length > 0) {
                const price = data.chart.result[0].meta.regularMarketPrice;
                if (price) return res.json({ price, source: 'Yahoo Finance' });
            }
        } catch (e) {
            console.log(`Yahoo API fallito per ticker: ${ticker}`);
        }
    }

    // SE C'È L'ISIN, PARTIAMO CON LA CASCATA DI WEB SCRAPING
    if (isin) {
        const cleanIsin = isin.trim().toUpperCase();

        // 2. TENTATIVO: JUSTETF (Ottimo per ETF e ETC)
        try {
            const jUrl = `https://www.justetf.com/it/etf-profile.html?isin=${cleanIsin}`;
            const { data } = await axios.get(jUrl, { headers });
            const $ = cheerio.load(data);
            
            // Estrazione prezzo HTML JustETF
            const priceText = $('.val span').first().text().trim().replace(',', '.');
            const price = parseFloat(priceText);
            
            if (!isNaN(price) && price > 0) return res.json({ price, source: 'JustETF' });
        } catch(e) {
            console.log(`JustETF fallito per ISIN: ${cleanIsin}`);
        }

        // 3. TENTATIVO: BORSA ITALIANA (Ottimo per BTP, BOT, Azioni ITA, Obbligazioni)
        try {
            // Cerchiamo direttamente la scheda di dettaglio tramite ISIN
            const bUrl = `https://www.borsaitaliana.it/borsa/ricerca/dettaglio.html?isin=${cleanIsin}`;
            const { data } = await axios.get(bUrl, { headers });
            const $ = cheerio.load(data);
            
            // Borsa Italiana usa varie classi per i prezzi, testiamo le principali
            let priceText = $('.summary-value').first().text().trim() || 
                            $('span.-block._dow').first().text().trim() ||
                            $('span.t-text-right').first().text().trim();
            
            // Pulizia del formato europeo (es. "1.234,56 €" -> "1234.56")
            priceText = priceText.replace('€', '').replace(/\./g, '').replace(',', '.').trim();
            const price = parseFloat(priceText);
            
            if (!isNaN(price) && price > 0) return res.json({ price, source: 'Borsa Italiana' });
        } catch(e) {
            console.log(`Borsa Italiana fallito per ISIN: ${cleanIsin}`);
        }

        // 4. TENTATIVO: MARKETS VONTOBEL (Ottimo per i Certificati)
        try {
            // Proviamo a cercare direttamente nella barra di ricerca
            const vUrl = `https://markets.vontobel.com/it-it/prodotti/ricerca?query=${cleanIsin}`;
            const { data } = await axios.get(vUrl, { headers });
            const $ = cheerio.load(data);
            
            // I prezzi sui certificati di solito sono "Bid" (Denaro) e "Ask" (Lettera). 
            // Cerchiamo il valore Ask (prezzo di acquisto/mercato).
            let priceText = $('.ask-price').first().text().trim() || 
                            $('.price-value').first().text().trim() || 
                            $('td[data-col="ask"]').first().text().trim();

            // Pulizia formato valuta Vontobel
            priceText = priceText.replace('EUR', '').replace('€', '').replace(/\./g, '').replace(',', '.').trim();
            const price = parseFloat(priceText);
            
            if (!isNaN(price) && price > 0) return res.json({ price, source: 'Vontobel' });
        } catch(e) {
            console.log(`Vontobel fallito per ISIN: ${cleanIsin}`);
        }
    }

    // Se arriviamo qui, l'asset non è stato trovato o i siti hanno bloccato la richiesta
    res.status(404).json({ error: 'Prezzo non trovato con nessun metodo' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server API & Scraping in ascolto sulla porta ${PORT}`);
});
