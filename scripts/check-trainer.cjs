const fs = require("fs");
const h = fs.readFileSync("frontend/public/trainer.html", "utf8");
const m = h.match(/const DATA = (\{[\s\S]*?\});/);
const d = JSON.parse(m[1]);
console.log(JSON.stringify({
  title: d.title,
  count: d.count,
  cats: d.cats.length,
  first: d.items[0],
  last: d.items[d.items.length - 1],
  hasStarScope: h.includes('value="star"'),
  key: h.includes("speakmate.handbook.v1"),
  back: h.includes("backApp"),
}, null, 2));
