const express = require("express")
const PORT = process.env.PORT || 3000

const app = express();
app.use(express.json());

app.use(async(req, res) => {
    if (req.method === "POST") {
        res.send("Hello post");
    } else if (req.method === "GET") {
        res.send("Hello get");
    } else {
        res.send("Hello");
    }
});

app.listen(PORT, function(err) {
    if (err) console.log(err);
    console.log("Server listening on PORT", PORT);
});
