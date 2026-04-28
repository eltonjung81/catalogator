const axios = require('axios');

async function test() {
  const url = `https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1m&limit=20`;
  const response = await axios.get(url);
  const data = response.data;
  
  for(let i=0; i<data.length; i++) {
     const date = new Date(data[i][0]);
     const totalMinutes = (date.getUTCHours() * 60) + date.getUTCMinutes();
     console.log(`${date.toISOString()} - totalMinutes: ${totalMinutes} - isOnBoundary: ${totalMinutes % 5 === 0}`);
  }
}

test();
