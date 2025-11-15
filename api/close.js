const { ExchangeClient, HttpTransport } = require('@nktkas/hyperliquid');
const { Wallet } = require('ethers');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const config = req.body;
    
    const symbol = config.market || config.symbol;
    const mainWallet = config.main_wallet;
    const privateKey = config.agent_key;
    const size = String(config.size);
    
    const wallet = new Wallet(privateKey);
    const transport = new HttpTransport({ 
      url: 'https://api.hyperliquid.xyz'
    });
    
    const client = new ExchangeClient({
      transport,
      wallet,
      walletAddress: mainWallet
    });
    
    const order = {
      coin: symbol,
      is_buy: false,
      sz: size,
      limit_px: '0',
      order_type: { limit: { tif: 'Ioc' } },
      reduce_only: true
    };
    
    const result = await client.placeOrder(order);
    
    res.status(200).json({
      success: true,
      response: result,
      exit_price: result?.data?.statuses?.[0]?.filled?.avgPx || null,
      timestamp: Date.now()
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        message: error.message,
        type: error.name
      }
    });
  }
};
