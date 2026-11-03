const fs = require('fs');

const karatPath = 'D:/Work/myresume/karat-english-trainer.html';
const handbookPath = 'D:/Work/SpeakMate/miniprogram/data/handbook.json';
const outPath = 'D:/Work/SpeakMate/frontend/public/trainer.html';

let html = fs.readFileSync(karatPath, 'utf8');
const handbook = JSON.parse(fs.readFileSync(handbookPath, 'utf8'));

const DATA = {
  title: handbook.title,
  count: handbook.items.length,
  cats: handbook.cats,
  items: handbook.items.map((it) => ({
    cat: it.cat,
    scene: it.scene || '',
    zh: it.zh || '',
    en: it.en || '',
  })),
  meta: {
    source: 'SpeakMate miniprogram/data/handbook.json',
    generatedAt: new Date().toISOString(),
    note: 'Karat-style H5 trainer using latest SpeakMate workplace IT English handbook',
  },
};

if (!/const DATA = \{[\s\S]*?\};/.test(html)) {
  console.error('DATA blob not found');
  process.exit(1);
}
html = html.replace(/const DATA = \{[\s\S]*?\};/, 'const DATA = ' + JSON.stringify(DATA) + ';');

html = html.replace(/<title>[\s\S]*?<\/title>/, '<title>' + DATA.title + ' · SpeakMate 训练</title>');
html = html.replace(/<h1>日常工作英语<\/h1>/, '<h1>' + DATA.title + '</h1>');
html = html.replace(/听力 · 跟读 · 232 句/, '听力 · 跟读 · ' + DATA.count + ' 句 · SpeakMate');
html = html.replace(/id="buildTag">[^<]*/, 'id="buildTag">SpeakMate handbook · ' + DATA.count + ' 句');
html = html.replace(/const KEY = '[^']*'/, "const KEY = 'speakmate.handbook.v1'");

if (!html.includes('value="star"')) {
  html = html.replace(
    '<option value="known">已掌握的</option>',
    '<option value="known">已掌握的</option>\n            <option value="star">已收藏</option>'
  );
}

html = html.replace(
  /if \(S\.scope !== 'all'\) idx = idx\.filter\(i => \(rec\(i\)\.s === \(S\.scope === 'known' \? 'known' : S\.scope === 'weak' \? 'weak' : 'new'\)\)\);/,
  "if (S.scope === 'star') idx = idx.filter(i => !!rec(i).star);\n  else if (S.scope !== 'all') idx = idx.filter(i => (rec(i).s === (S.scope === 'known' ? 'known' : S.scope === 'weak' ? 'weak' : 'new')));"
);

html = html.replace('id="srcBadge">浏览器合成</span>', 'id="srcBadge">浏览器 TTS</span>');

fs.writeFileSync(outPath, html, 'utf8');
console.log('Wrote', outPath, 'bytes', fs.statSync(outPath).size, 'items', DATA.count, 'cats', DATA.cats.length);
const m = html.match(/const DATA = (\{[\s\S]*?\});/);
const parsed = JSON.parse(m[1]);
console.log('reparse ok', parsed.count, parsed.items[0].en);
