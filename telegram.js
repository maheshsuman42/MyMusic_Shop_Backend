/**
 * Telegram Notification Service
 * Sends alerts to admin via Telegram Bot API
 */
export async function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn(
      "Telegram Bot Token or Chat ID not configured. Skipping alert.",
    );
    return;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
      }),
    });
    if (!response.ok) {
      const errorData = await response.json();
      console.error("Telegram API Error:", errorData);
    }
  } catch (err) {
    console.error("Failed to send Telegram alert:", err);
  }
}
export const formatNewOrderAlert = (order, userName) => {
  return `
📦 <b>NEW ORDER PLACED</b> 📦
-------------------------
<b>Order ID:</b> ${order._id || order.id}
<b>Customer:</b> ${userName}
<b>Amount:</b> ₹${order.totalAmount}
<b>Payment:</b> ${order.paymentMethod.toUpperCase()}

<b>Items:</b>
${order.items.map((i) => `- ${i.productName || "Instrument"} (x${i.quantity})`).join("\n")}

<pre>View in Admin Dashboard</pre>
  `.trim();
};
export const formatLowStockAlert = (product) => {
  return `
⚠️ <b>LOW STOCK ALERT</b> ⚠️
-------------------------
<b>Product:</b> ${product.name}
<b>Current Stock:</b> <b>${product.stock}</b>
<b>Category:</b> ${product.category}

<i>Please restock as soon as possible.</i>
  `.trim();
};
