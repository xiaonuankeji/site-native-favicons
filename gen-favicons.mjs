// 站点图标生成脚本（独立项目：site-native-favicons）。
//
// 本项目与 site-native 主应用解耦，单独维护所有内置站点的图标：
//   - catalog.json  ：站点列表元数据（id + url + icon_source 等），本脚本只用到 id 与 url。
//   - icons/{id}.png：生成的 128×128 透明 PNG，部署到 CDN（GitHub Pages / jsDelivr / Cloudflare Pages）。
//   - 主应用运行时（前端 iconCdn.ts + C# IconCdn.cs）从 CDN 读取这些图标，
//     安装站点应用时也由 C# 侧从 CDN 拉取，避免在主应用里重新解析网页踩坑。
//
// 用法（需先 `npm install` 安装 sharp / undici）：
//   npm run gen
//
// 说明：
//   - 本脚本在开发者机器上运行（非用户机器），可联网；不影响最终产物的隐私属性。
//   - 支持通过环境变量 HTTPS_PROXY / HTTP_PROXY 走代理（用 undici 的 ProxyAgent + 显式 dispatcher）。
//   - 抓取链：主源 Google s2（sz=256，覆盖绝大多数站点）；
//     仅当 Google 返回低清图（真实像素宽 < MIN_WIDTH）时，才解析站点首页 HTML，
//     把其中声明的所有 <link rel="icon*">（含 apple-touch、含带 sizes 的大图、含根 /favicon.ico）
//     全部抓下来，按真实像素宽择优，不偏袒 apple-touch。
//   - ICON_OVERRIDES 提供「站点 id -> 显式图标直链」覆盖：命中后直接用这张图、跳过上述抓取链
//     （用于 favicon 服务只能给到小图、但官网另有清晰品牌图的站点，如 tiktok）。
//     支持栅格 / ICO / SVG 直链：ICO 会在 tryNormalize 内先抽内嵌的 PNG 帧、抽不到再解 DIB/BMP 帧（如 deepseek 的 favicon.ico），
//     再交给 sharp 栅格化；SVG 由 sharp 直接栅格化；不引入额外依赖。
//     bitbucket 官网 favicon 是内联 SVG（无 URL 可抓），走 ICON_SVG_OVERRIDES 处理。
//   - 手动钉住图标：catalog 中 icon_source === "manual" 的站点（如 evernote，其 PNG 由用户手动编辑），
//     生成器原样保留 icons/{id}.png，跳过包括内联 SVG 覆盖在内的全部来源，绝不重新抓取或重栅格化。
//   - 任一阵营成功即归一化落盘；全部失败则该站点在本项目中无图标（主应用会回退到品牌字形 / 首字母）。
//   - 失败会被分级记录（网络错误 / HTTP 状态码 / content-type 不符 / 解码失败），
//     并写入临时报告文件，方便排查是网络问题还是源本身没有可用图标。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalogPath = path.join(__dirname, 'catalog.json'); // 本项目内的站点元数据
const outDir = path.join(__dirname, 'icons'); // 生成的图标输出到此目录，再部署到 CDN
const reportPath = path.join(os.tmpdir(), 'favicon-gen-report.json');

const SIZE = 128;
const MIN_WIDTH = 128; // 源图达到此宽即视为足够清晰，可提前停止（避免放大发虚）
const CONCURRENCY = 6;
const TIMEOUT_MS = 15000; // 走代理时延迟更高，放宽到 15s
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 SiteNative/1.0';

// 站点 id -> 显式图标直链（栅格图 / ICO / SVG URL 都行）。
// 命中后直接抓这张图、跳过 Google s2 / 站点 HTML 解析。
// 用于 favicon 服务只能给到小图、但官网另有清晰品牌图的站点（如 tiktok），
// 以及 Google / Atlassian 等官网把高清 favicon 直接挂在 gstatic 的站点（如 gmail、googledocs、gemini）。
const ICON_OVERRIDES = {
  tiktok: 'https://sf-static.tiktokcdn.com/obj/eden-sg/uhtyvueh7nulogpoguhm/tiktok-icon2.png',
  gmail: 'https://ssl.gstatic.com/ui/v1/icons/mail/images/favicon_gmail_2026_v2.ico',
  googledocs: 'https://ssl.gstatic.com/docs/documents/images/docs-favicon-2026-v2.ico',
  gemini: 'https://www.gstatic.com/lamda/images/gemini_sparkle_aurora_33f86dc0c0257da337c63.svg',
  deepseek: 'https://www.deepseek.com/favicon.ico',
};

// 站点 id -> 内联 SVG 字符串。官网 favicon 是矢量且无可用栅格直链时使用（如 bitbucket）。
// 命中后用 sharp 直接栅格化为 128×128 透明 PNG、跳过所有网络抓取；不引入额外依赖（sharp 自带 SVG 栅格化）。
const ICON_SVG_OVERRIDES = {
  bitbucket:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">' +
    '<path d="M0 12C0 5.37258 5.37258 0 12 0H36C42.6274 0 48 5.37258 48 12V36C48 42.6274 42.6274 48 36 48H12C5.37258 48 0 42.6274 0 36V12Z" fill="#94C748"/>' +
    '<path d="M35.6852 23.5267L33.7129 35.5747C33.5843 36.3036 33.0698 36.7323 32.3409 36.7323H15.6195C14.8906 36.7323 14.3761 36.3036 14.2475 35.5747L10.7746 14.0941C10.6459 13.3652 11.0318 12.8936 11.7178 12.8936H36.2426C36.9286 12.8936 37.3145 13.3652 37.1858 14.0941L36.2426 19.7536C36.1139 20.5683 35.6423 20.9113 34.8706 20.9113H20.1214C19.907 20.9113 19.7784 21.0399 19.8213 21.2971L20.9789 28.4145C21.0218 28.586 21.1504 28.7146 21.3219 28.7146H26.6385C26.81 28.7146 26.9386 28.586 26.9815 28.4145L27.7961 23.2694C27.8819 22.6263 28.3106 22.369 28.9109 22.369H34.6991C35.5566 22.369 35.8138 22.7978 35.6852 23.5267Z" fill="#101214"/>' +
    '</svg>',
};

// fetchImpl 默认用全局 fetch；若设置了代理，则改用 undici 自带 fetch + 显式 dispatcher。
// 关键坑：外部 undici 的 setGlobalDispatcher 改不了 Node 内置 fetch 所用的那份 undici 实例，
// 必须用 undici.fetch 并显式传入 dispatcher 才能让代理真正生效。
let fetchImpl = globalThis.fetch;

function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

async function configureProxy() {
  // 1) 最高优先级：显式环境变量（手动覆盖）
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (envProxy) {
    await applyProxy(envProxy, 'env var');
    return;
  }

  // 2) Windows 系统代理（IE / Internet Settings）。
  //    浏览器、PowerShell 的 curl.exe 都读这里；但 Node 的 fetch 与 Git Bash 的 curl
  //    默认【不】继承系统代理，必须显式读出再注入，否则会像之前一样直连失败。
  if (process.platform === 'win32') {
    const sys = detectWindowsSystemProxy();
    if (sys) {
      await applyProxy(sys, 'Windows system proxy (IE/Internet Settings)');
      return;
    }
  }

  console.log('No proxy env and no Windows system proxy found — using direct connection.');
}

async function applyProxy(proxyUrl, source) {
  try {
    const undici = await import('undici');
    const dispatcher = new undici.ProxyAgent(proxyUrl);
    fetchImpl = (url, opts = {}) => undici.fetch(url, { ...opts, dispatcher });
    console.log(`Using proxy (${source}): ${proxyUrl}`);
  } catch (e) {
    console.warn('Proxy configured but undici not installed; falling back to direct. Error:', e.message);
  }
}

function detectWindowsSystemProxy() {
  try {
    const out = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /v ProxyServer /v AutoConfigURL',
      { encoding: 'utf8', windowsHide: true }
    );
    const enable = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(out);
    if (!enable || parseInt(enable[1], 16) === 0) return null;
    const server = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(out);
    const pac = /AutoConfigURL\s+REG_SZ\s+(\S+)/.exec(out);
    if (!server) {
      if (pac) {
        console.warn(
          'System proxy is PAC (AutoConfigURL); PAC auto-detection is not supported.\n' +
            '  Please set HTTPS_PROXY explicitly, e.g.:\n' +
            '    export HTTPS_PROXY=http://127.0.0.1:7890   # 换成你的代理端口'
        );
      }
      return null;
    }
    return parseProxyServer(server[1]);
  } catch {
    return null;
  }
}

function parseProxyServer(s) {
  // 形如 http=127.0.0.1:7890;https=127.0.0.1:7890 或 127.0.0.1:7890 或 socks=127.0.0.1:7891
  if (s.includes('=')) {
    const parts = s.split(';').map((p) => p.trim());
    const https = parts.find((p) => p.toLowerCase().startsWith('https='));
    const http = parts.find((p) => p.toLowerCase().startsWith('http='));
    const socks = parts.find((p) => p.toLowerCase().startsWith('socks='));
    const pick = https || http || socks;
    if (!pick) return null;
    const hostPort = pick.slice(pick.indexOf('=') + 1);
    const scheme = pick.toLowerCase().startsWith('socks') ? 'socks://' : 'http://';
    return scheme + hostPort;
  }
  return 'http://' + s;
}

async function testConnectivity() {
  try {
    const r = await fetchImpl('https://www.google.com/s2/favicons?domain=github.com&sz=64', {
      headers: { 'User-Agent': UA },
    });
    console.log(`Connectivity probe: HTTP ${r.status} ${r.headers.get('content-type') || '(no ct)'}`);
  } catch (e) {
    console.warn('Connectivity probe FAILED — network/proxy not working:', e.message);
  }
}

// 返回 { ok:true, buf } 或 { ok:false, kind, status?, ct?, message? }
// kind: 'network' | 'http' | 'contenttype'
async function fetchBuffer(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA },
    });
    if (!res.ok) {
      return { ok: false, kind: 'http', status: res.status };
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) {
      return { ok: false, kind: 'contenttype', ct };
    }
    return { ok: true, buf: Buffer.from(await res.arrayBuffer()) };
  } catch (e) {
    return { ok: false, kind: 'network', message: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// 主源：Google s2（sz=256 尽量拿高清）。这是绝大多数站点的唯一来源；
// 少数 Google 只回低清图的站点，由下方 HTML 解析兜底，无需在此堆多源。
function sourcesFor(domain) {
  return [
    `https://www.google.com/s2/favicons?domain=${domain}&sz=256`,
  ];
}

// 若 buffer 是 ICO 容器且内嵌了 PNG 帧，返回最大的那张 PNG 帧字节；否则原样返回。
// 现代 .ico（gmail / docs 这类）通常把 256×256 PNG 直接塞进 ICONDIRENTRY 后；
// libvips 的 ico loader 解不出这种结构，但内嵌的 PNG sharp 能解。这一步让所有 .ico
// 来源（s2 / gstatic / Apple-touch 等）都能稳定走到 sharp 这条路。
function maybeExtractIcoPng(buf) {
  if (
    buf.length < 22 ||
    buf[0] !== 0x00 ||
    buf[1] !== 0x00 ||
    buf[2] !== 0x01 ||
    buf[3] !== 0x00
  )
    return buf;
  const count = buf.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count && i < 256; i++) {
    const o = 6 + i * 16;
    if (o + 16 > buf.length) break;
    const w = buf[o] === 0 ? 256 : buf[o];
    const bytesInRes = buf.readUInt32LE(o + 8);
    const imageOffset = buf.readUInt32LE(o + 12);
    if (!bytesInRes || imageOffset + bytesInRes > buf.length) continue;
    const frame = buf.subarray(imageOffset, imageOffset + bytesInRes);
    const isPng = frame[0] === 0x89 && frame[1] === 0x50 && frame[2] === 0x4e && frame[3] === 0x47;
    if (isPng && (!best || w > best.width)) best = { width: w, frame };
  }
  return best ? Buffer.from(best.frame) : buf;
}

// 解析 ICO 容器里的 DIB/BMP 内嵌帧（无 PNG 帧、纯 BMP 的 .ico，如 deepseek 的 favicon.ico）。
// 返回 { width, height, raw: RGBA Buffer } 供 sharp 以 raw 输入栅格化；不支持调色板（<=8bpp）。
// 仅处理 32/24bpp 真彩帧；ICO 的 32bpp 帧是预乘 alpha，这里按像素反预乘回直线 alpha（不透明像素无副作用）。
function decodeIcoDib(ico) {
  if (
    ico.length < 22 ||
    ico[0] !== 0x00 ||
    ico[1] !== 0x00 ||
    ico[2] !== 0x01 ||
    ico[3] !== 0x00
  )
    return null;
  const count = ico.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count && i < 256; i++) {
    const o = 6 + i * 16;
    if (o + 16 > ico.length) break;
    const w = ico[o] === 0 ? 256 : ico[o];
    const h = ico[o + 1] === 0 ? 256 : ico[o + 1];
    const bitCount = ico.readUInt16LE(o + 6);
    const bytesInRes = ico.readUInt32LE(o + 8);
    const imageOffset = ico.readUInt32LE(o + 12);
    if (!bytesInRes || imageOffset + bytesInRes > ico.length) continue;
    if (bitCount !== 32 && bitCount !== 24) continue; // 仅处理无调色板的真彩帧
    const data = ico.subarray(imageOffset, imageOffset + bytesInRes);
    const hdrSize = data.readUInt32LE(0);
    const bw = data.readUInt32LE(4);
    const compression = data.readUInt32LE(16);
    if (compression !== 0) continue; // 仅 BI_RGB
    const channels = bitCount / 8;
    const stride = (bw * channels + 3) & ~3;
    const realH = h; // ICO 中可能 biHeight=2*h（含 AND 掩码），真实高取 entry 的 h
    if (hdrSize + realH * stride > data.length) continue;
    const px = Buffer.alloc(bw * realH * 4);
    for (let y = 0; y < realH; y++) {
      const srcRow = hdrSize + y * stride; // ICO 自顶向下存储
      const dstRow = y * bw * 4;
      for (let x = 0; x < bw; x++) {
        const s = srcRow + x * channels;
        const d = dstRow + x * 4;
        if (channels === 4) {
          let a = data[s + 3];
          let r = data[s + 2];
          let g = data[s + 1];
          let b = data[s];
          if (a > 0 && a < 255) {
            // 反预乘 alpha
            r = Math.min(255, Math.round((r * 255) / a));
            g = Math.min(255, Math.round((g * 255) / a));
            b = Math.min(255, Math.round((b * 255) / a));
          }
          px[d] = r;
          px[d + 1] = g;
          px[d + 2] = b;
          px[d + 3] = a;
        } else {
          px[d] = data[s + 2];
          px[d + 1] = data[s + 1];
          px[d + 2] = data[s];
          px[d + 3] = 255;
        }
      }
    }
    if (!best || w > best.width) best = { width: w, height: realH, raw: px };
  }
  return best;
}

async function tryNormalize(buf) {
  try {
    const src = maybeExtractIcoPng(buf);
    const meta = await sharp(src).metadata();
    const png = await sharp(src)
      .resize(SIZE, SIZE, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    return { png, width: meta.width || 0 };
  } catch {
    // PNG-in-ICO 解不出时，再试 DIB/BMP 内嵌帧（如 deepseek / evernote 的 favicon.ico）。
    const dib = decodeIcoDib(buf);
    if (!dib) return null;
    try {
      const png = await sharp(dib.raw, {
        raw: { width: dib.width, height: dib.height, channels: 4 },
      })
        .resize(SIZE, SIZE, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();
      return { png, width: dib.width };
    } catch {
      return null;
    }
  }
}

// 从站点首页 HTML 中解析出“站点自己声明的高清图标”候选 URL（apple-touch-icon / 带 sizes 的大图优先）。
// 这是解决“Google s2 返回低清原图被放大发虚”的关键：站点自有的 apple-touch-icon 通常是 180px 级、清晰。
function extractIconCandidates(html, base) {
  const candidates = [];
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    const relM = /\brel=["']([^"']*)["']/i.exec(tag);
    const hrefM = /\bhref=["']([^"']*)["']/i.exec(tag);
    if (!relM || !hrefM) continue;
    const rel = relM[1].toLowerCase();
    if (!/icon|apple-touch/.test(rel)) continue;
    const href = hrefM[1];
    // 跳过 data: URI 与 SVG（sharp 默认无法栅格化 SVG，且矢量图大多无尺寸优势）
    if (!href || href.startsWith('data:') || /\.svg(\?|$)/i.test(href)) continue;
    let size = 0;
    const sizesM = /\bsizes=["']([^"']*)["']/i.exec(tag);
    if (sizesM) {
      const s = sizesM[1].toLowerCase().trim();
      if (s === 'any') size = 256;
      else {
        const dims = s.match(/(\d+)\s*x\s*(\d+)/);
        if (dims) size = Math.max(+dims[1], +dims[2]);
      }
    }
    let score = size;
    try {
      candidates.push({ url: new URL(href, base).href, score });
    } catch {
      /* ignore */
    }
  }
  // 按声明尺寸从大到小排序（无 sizes 的排最后）。最终仍以“真实像素宽”择优，
  // 这里只是让大图先被尝试；所有候选都会被抓下来分析，不偏袒 apple-touch。
  candidates.sort((a, b) => b.score - a.score);
  return candidates.map((c) => c.url);
}

async function discoverIcon(domain) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`https://${domain}/`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html')) return null;
    const html = await res.text();
    const links = extractIconCandidates(html, `https://${domain}/`);
    // 许多站点只在根路径放 favicon.ico 而不在 HTML 里声明，补一个候选。
    return [...links, `https://${domain}/favicon.ico`];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function summarizeReasons(perSource) {
  // 推断该站点最主要的失败原因
  if (perSource.some((r) => r.kind === 'network')) return 'network';
  if (perSource.some((r) => r.kind === 'http' && r.status !== 404)) return `http(${perSource.find((r) => r.kind === 'http' && r.status !== 404).status})`;
  if (perSource.some((r) => r.kind === 'contenttype')) return 'contenttype';
  if (perSource.some((r) => r.kind === 'http')) return 'http(404)';
  return 'unknown';
}

async function run() {
  await configureProxy();
  await testConnectivity();

  const raw = await readFile(catalogPath, 'utf8');
  const sites = JSON.parse(raw);
  await mkdir(outDir, { recursive: true });

  const targets = sites.filter((s) => s && s.id && s.url && domainOf(s.url));

  // 手动钉住的图标：catalog 中 icon_source === "manual" 的站点，其 PNG 由人工制作，
  // 生成器必须原样保留、不得用 Google s2 / 官网抓取 / 内联 SVG 覆盖去替换。
  const manualIds = new Set(sites.filter((s) => s && s.icon_source === 'manual').map((s) => s.id));
  console.log(`\nSites to process: ${targets.length} (catalog has ${sites.length})\n`);

  const ok = [];
  const failed = [];
  const report = [];
  let cursor = 0;

  async function worker() {
    while (cursor < targets.length) {
      const site = targets[cursor++];
      const domain = domainOf(site.url);
      let best = null; // { png, width }
      const perSource = [];

      // 0) 手动钉住：用户手动编辑的图标，原样保留、跳过一切抓取与覆盖。
      if (manualIds.has(site.id)) {
        const manualPath = path.join(outDir, `${site.id}.png`);
        if (existsSync(manualPath)) {
          ok.push(site.id);
          continue;
        }
        // 手动图标文件丢失：不回退到网络抓取（那会违背“手动、不替换”的意图），仅记录缺失。
        failed.push(site.id);
        report.push({
          id: site.id, domain, url: site.url, reason: 'manual-icon-missing',
          perSource: [{ src: 'manual-pin', result: 'manual-icon-missing' }],
        });
        continue;
      }

      // 0a) 内联 SVG 覆盖（官网 favicon 为矢量、且无可用栅格直链的站点，如 bitbucket）。
      //     命中后直接栅格化落盘、跳过所有网络抓取；栅格化失败则回退到通用链。
      const svgOverride = ICON_SVG_OVERRIDES[site.id];
      if (svgOverride) {
        try {
          const png = await sharp(Buffer.from(svgOverride))
            .resize(SIZE, SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer();
          await writeFile(path.join(outDir, `${site.id}.png`), png);
          ok.push(site.id);
          continue;
        } catch (e) {
          perSource.push({ src: 'inline-svg', result: 'decode-fail', message: e.message });
        }
      }

      // 0) 显式覆盖直链（如 tiktok 的官方 CDN 高清图）。命中优先、失败再回退到通用链。
      const overrideUrl = ICON_OVERRIDES[site.id];
      if (overrideUrl) {
        const r = await fetchBuffer(overrideUrl);
        if (r.ok) {
          const n = await tryNormalize(r.buf);
          if (n) {
            best = n;
            perSource.push({ src: overrideUrl, result: 'ok', width: n.width, override: true });
          } else {
            perSource.push({ src: overrideUrl, result: 'decode-fail', override: true });
          }
        } else {
          perSource.push({ src: overrideUrl, result: r.kind, ...r, override: true });
        }
      }

      // 1) 主源：Google s2（仅当覆盖未给出足够清晰图时）。拿到即归一化、量真实像素宽。
      if (!best || best.width < MIN_WIDTH) {
        for (const src of sourcesFor(domain)) {
          const r = await fetchBuffer(src);
          if (!r.ok) {
            perSource.push({ src, result: r.kind, ...r });
            continue;
          }
          const n = await tryNormalize(r.buf);
          if (!n) {
            perSource.push({ src, result: 'decode-fail' });
            continue;
          }
          perSource.push({ src, result: 'ok', width: n.width });
          if (!best || n.width > best.width) best = n;
        }
      }

      // 2) 若仍不够清晰（< MIN_WIDTH），解析站点首页 HTML，把其中声明的【所有】
      //    <link rel="icon*"> 图标（含 apple-touch、含带 sizes 的大图、含根 /favicon.ico）
      //    全部抓下来，按真实像素宽择优。不偏袒 apple-touch、不提前中断，确保分析到每一个。
      if (!best || best.width < MIN_WIDTH) {
        const discovered = await discoverIcon(domain);
        for (const src of discovered || []) {
          const r = await fetchBuffer(src);
          if (!r.ok) {
            perSource.push({ src, result: r.kind, ...r });
            continue;
          }
          const n = await tryNormalize(r.buf);
          if (!n) {
            perSource.push({ src, result: 'decode-fail' });
            continue;
          }
          perSource.push({ src, result: 'ok', width: n.width });
          if (!best || n.width > best.width) best = n;
        }
      }

      const out = best ? best.png : null;
      if (out) {
        await writeFile(path.join(outDir, `${site.id}.png`), out);
        ok.push(site.id);
      } else {
        const reason = summarizeReasons(perSource);
        failed.push(site.id);
        report.push({
          id: site.id,
          domain,
          url: site.url,
          reason,
          perSource: perSource.map((p) => ({
            src: p.src,
            result: p.result,
            width: p.width,
            status: p.status,
            ct: p.ct,
            message: p.message,
          })),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // 失败原因汇总
  const reasonCounts = {};
  for (const r of report) {
    reasonCounts[r.reason] = (reasonCounts[r.reason] || 0) + 1;
  }

  console.log(`Favicons generated: ${ok.length} ok, ${failed.length} failed (of ${targets.length} sites).`);
  if (failed.length) {
    console.log('Failure reason breakdown:', JSON.stringify(reasonCounts));
    console.log('Failed site IDs:', failed.join(', '));
    // 报告路径
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`Detailed per-site report written to: ${reportPath}`);
    // 打印前 3 个失败站点的逐源细节，便于快速定位
    console.log('\nSample failures (first 3):');
    for (const r of report.slice(0, 3)) {
      console.log(`  [${r.id}] ${r.domain} -> ${r.reason}`);
      for (const p of r.perSource) {
        const extra = p.status ? ` status=${p.status}` : p.ct ? ` ct=${p.ct}` : p.message ? ` err=${p.message}` : '';
        console.log(`      - ${p.result}${extra}  ${p.src}`);
      }
    }
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
