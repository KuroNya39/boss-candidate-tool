// 探测在线简历弹窗的真实 DOM 结构
import http from 'node:http';

function proxyGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:3456${path}`, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    }).on('error', reject);
  });
}

async function cdpEval(targetId, expr) {
  const r = await proxyGet(`/eval?target=${targetId}&expr=${encodeURIComponent(expr)}`);
  console.log('  [debug] raw response:', JSON.stringify(r).slice(0, 300));
  if (r.error) throw new Error(r.error);
  return r.result !== undefined ? r.result : r.value !== undefined ? r.value : r;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // 获取当前活跃的 tab
  const targets = await proxyGet('/targets');
  const zhipinTab = targets.find(t => t.url && t.url.includes('zhipin.com'));
  if (!zhipinTab) {
    console.log('未找到 Boss 直聘页面，请先在浏览器中打开');
    console.log('当前页面:', targets.map(t => t.title || t.url).join(', '));
    process.exit(1);
  }
  const targetId = zhipinTab.targetId;
  console.log(`找到 Boss 直聘页面: ${targetId}\n`);

  // 点击第一个候选人的在线简历
  console.log('检查页面状态...');
  const pageState = await cdpEval(targetId, `(function(){
    var result = {
      url: location.href,
      resumeBtn: !!document.querySelector('a.btn.resume-btn-online'),
      resumeBtnAll: Array.from(document.querySelectorAll('a[class*=resume]')).map(function(a){
        return {tag: a.tagName, cls: a.className, text: a.textContent.trim().slice(0,30), href: a.href};
      }),
      allBtns: Array.from(document.querySelectorAll('.resume-btn-online, [class*="resume-btn"]')).map(function(el){
        return {tag: el.tagName, cls: el.className, text: el.textContent.trim().slice(0,30)};
      }),
      resumeDetail: !!document.querySelector('.resume-detail')
    };
    return JSON.stringify(result);
  })()`);
  console.log(`页面状态: ${pageState}\n`);
  
  console.log('点击在线简历按钮...');
  const clickResult = await cdpEval(targetId, `(function(){
    var btn = document.querySelector('a.btn.resume-btn-online') || document.querySelector('[class*="resume-btn-online"]');
    if (!btn) return 'not-found';
    btn.click();
    return 'clicked: ' + btn.className;
  })()`);
  console.log(`结果: ${JSON.stringify(clickResult)}`);
  if (!clickResult || clickResult === 'not-found') {
    console.log('未找到在线简历按钮');
    process.exit(1);
  }

  // 每 500ms 检查一次 DOM 结构，持续 15 秒
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const info = await cdpEval(targetId, `(function(){
      var detail = document.querySelector('.resume-detail');
      if (!detail) return JSON.stringify({time: ${i * 500}, status: 'no .resume-detail'});
      
      var rect = detail.getBoundingClientRect();
      var result = {
        time: ${i * 500},
        detailSize: Math.round(rect.width) + 'x' + Math.round(rect.height),
        scrollHeight: detail.scrollHeight,
        clientHeight: detail.clientHeight,
        childCount: detail.children.length,
        childTags: Array.from(detail.children).map(function(c){ return c.tagName + (c.className ? '.' + c.className.split(' ')[0] : ''); }).join(', ')
      };
      
      var iframe = detail.querySelector('iframe');
      if (iframe) {
        result.hasIframe = true;
        result.iframeSize = iframe.offsetWidth + 'x' + iframe.offsetHeight;
        try {
          var idoc = iframe.contentDocument || iframe.contentWindow.document;
          var body = idoc.body;
          result.iframeBodyChildren = Array.from(body.children).map(function(c){
            return c.tagName + (c.id ? '#' + c.id : '') + ' ' + c.offsetWidth + 'x' + c.offsetHeight;
          }).join(', ');
          result.iframeBodyScrollHeight = body.scrollHeight;
          result.iframeBodyClientHeight = body.clientHeight;
          
          var canvas = idoc.querySelector('canvas');
          if (canvas) {
            result.canvas = {
              id: canvas.id,
              width: canvas.width,
              height: canvas.height,
              offsetWidth: canvas.offsetWidth,
              offsetHeight: canvas.offsetHeight,
              style: canvas.style.cssText
            };
          }
        } catch(e) {
          result.iframeCrossOrigin = true;
        }
      } else {
        result.hasIframe = false;
      }
      
      return JSON.stringify(result);
    })()`);
    
    const parsed = JSON.parse(info);
    console.log(`[${(i * 0.5).toFixed(1)}s] ${JSON.stringify(parsed, null, 2)}`);
    
    // 如果检测到 iframe 且有 canvas，就停止
    if (parsed.hasIframe && parsed.canvas) {
      console.log('\n✓ 检测到 iframe + canvas，探测完成');
      break;
    }
  }
  
  // 关闭弹窗
  await cdpEval(targetId, `(function(){
    var btn = document.querySelector('.dialog-wrap.active .close-btn')
      || document.querySelector('.boss-popup__close');
    if (btn) btn.click();
  })()`);
}

main().catch(console.error);
