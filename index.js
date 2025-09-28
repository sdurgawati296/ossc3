// index.js — aggressive parser + debug (replace your current file)
const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;

async function safeGoto(page, url) {
  try {
    return await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  } catch (e) {
    // try gentler fallback
    try { return await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }); }
    catch (e2) { throw e2; }
  }
}

async function parsePageAndReturnMap(url, debug=false) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
  await page.setViewport({ width: 1366, height: 768 });
  await page.setExtraHTTPHeaders({
    "accept-language": "en-US,en;q=0.9",
    "referer": (new URL(url)).origin
  });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
  });

  try {
    const resp = await safeGoto(page, url);
    const status = resp ? resp.status() : 0;

    // allow extra rendering time
    await page.waitForTimeout(1200);
    // capture full HTML and visible text
    const fullHtml = await page.content();
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '');

    // Candidate blocks: gather a lot of elements' innerText for debugging
    const candidateBlocks = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('body, div, section, td, li, aside, article, pre, table, p, tr, code'));
      const out = [];
      for (const n of nodes) {
        const txt = (n.innerText || '').trim();
        if (!txt) continue;
        // collect blocks that are either short or mention keywords
        if (txt.length < 800 || /Question\s*ID|Chosen\s*Option|Option\s*\d+\s*ID/i.test(txt)) out.push(txt);
      }
      // dedupe
      return Array.from(new Set(out)).slice(0, 300);
    });

    // Two parsing strategies:
    // A) parse by scanning candidate blocks (as before)
    // B) parse by scanning the entire HTML (so we don't miss things in attributes/tables)
    function parseFromBlocks(blocks) {
      const qidRe = /Question\s*ID\s*[:\u2013-]?\s*([A-Za-z0-9\-_]+)/ig;
      const optRe = /Option\s*([1-9][0-9]?)\s*ID\s*[:\u2013-]?\s*([A-Za-z0-9\-_]+)/ig;
      const chosenRe = /Chosen\s*Option\s*[:\u2013-]?\s*([0-9]+)/ig;
      const out = {};
      for (const block of blocks) {
        // find first QID in the block
        qidRe.lastIndex = 0;
        const qm = qidRe.exec(block);
        if (!qm) continue;
        const qid = qm[1].trim();
        // gather option ids
        optRe.lastIndex = 0;
        const optMap = {};
        let m;
        while ((m = optRe.exec(block)) !== null) optMap[m[1]] = m[2].trim();
        chosenRe.lastIndex = 0;
        const ch = chosenRe.exec(block);
        let chosenID = null;
        if (ch) {
          const chosenNum = ch[1].trim();
          chosenID = optMap[chosenNum] || null;
        }
        // fallback: try to find any long numeric id in the block
        if (!chosenID) {
          const idm = /([0-9]{6,})/.exec(block);
          if (idm) chosenID = idm[1];
        }
        out[qid] = chosenID || null;
      }
      return out;
    }

    function parseFromHTML(html) {
      // same regexes but scanned across whole html
      const qidRe = /Question\s*ID\s*[:\u2013-]?\s*([A-Za-z0-9\-_]+)/ig;
      const optRe = /Option\s*([1-9][0-9]?)\s*ID\s*[:\u2013-]?\s*([A-Za-z0-9\-_]+)/ig;
      const chosenRe = /Chosen\s*Option\s*[:\u2013-]?\s*([0-9]+)/ig;
      const out = {};
      // gather positions of qids first
      const qids = [];
      let qm;
      qidRe.lastIndex = 0;
      while ((qm = qidRe.exec(html)) !== null) qids.push({ qid: qm[1], idx: qm.index });
      for (let i=0;i<qids.length;i++) {
        const start = qids[i].idx;
        const end = (i+1<qids.length) ? qids[i+1].idx : html.length;
        const block = html.slice(start, end);
        // options
        optRe.lastIndex = 0;
        const optMap = {};
        let m;
        while ((m = optRe.exec(block)) !== null) optMap[m[1]] = m[2].trim();
        chosenRe.lastIndex = 0;
        const ch = chosenRe.exec(block);
        let chosenID = null;
        if (ch) {
          const chosenNum = ch[1].trim();
          chosenID = optMap[chosenNum] || null;
        }
        if (!chosenID) {
          const idm = /([0-9]{6,})/.exec(block);
          if (idm) chosenID = idm[1];
        }
        out[qids[i].qid] = chosenID || null;
      }
      return out;
    }

    const parsedFromBlocks = parseFromBlocks(candidateBlocks);
    const parsedFromHtml = parseFromHTML(fullHtml);

    // merge heuristics: prefer blocks parsing if non-empty, otherwise prefer html parse
    const merged = Object.assign({}, parsedFromHtml, parsedFromBlocks);

    await browser.close();

    if (debug) {
      return {
        parsed: merged,
        status,
        candidateBlocksCount: candidateBlocks.length,
        candidateBlocks: candidateBlocks.slice(0,60),
        bodyTextSnippet: (bodyText || "").slice(0,15000),
        htmlSnippet: (fullHtml || "").slice(0,15000)
      };
    }
    return { parsed: merged, status };

  } catch (err) {
    try { await browser.close(); } catch (e) {}
    throw err;
  }
}

app.get("/parse", async (req, res) => {
  const url = req.query.url;
  const debug = req.query.debug === "1" || req.query.debug === "true";
  if (!url) return res.status(400).json({ ok:false, error:"missing url" });
  try {
    const result = await parsePageAndReturnMap(url, debug);
    return res.json(Object.assign({ ok:true }, result));
  } catch (err) {
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

app.listen(PORT, () => console.log("listening", PORT));
