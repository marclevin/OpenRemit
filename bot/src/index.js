const express = require("express")
const { Bot, webhookCallback } = require("grammy")

const PORT = process.env.PORT || 3000
const app = express()
const bot = new Bot(process.env.BOT_TOKEN)

bot.on("message:text", (ctx) => {
    ctx.reply(ctx.message.text) // echo
})
bot.on("message:text", (ctx) => {
    console.log("Received:", ctx.message.text)
    ctx.reply(ctx.message.text)
})

app.use(express.json())
app.post("/webhook", webhookCallback(bot, "express"))

app.listen(PORT, function(err) {
    if (err) console.log(err)
    console.log("Server listening on PORT", PORT)
})
