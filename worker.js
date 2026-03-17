import { Hono } from 'hono'

const CONFIG = {
  UPSTREAM_URL: 'https://emos.best', // Replace with your Emby server URL
  
  // [关键修复] 
  // 1. 匹配带后缀的文件
  // 2. 匹配 Emby 特有的无后缀图片路径 (/Images/Primary, /Images/Backdrop 等)
  STATIC_REGEX: /(\.(jpg|jpeg|png|gif|css|js|ico|svg|webp|woff|woff2)|(\/Images\/(Primary|Backdrop|Logo|Thumb|Banner|Art)))/i,
  
  // 视频流 (直连，不缓存，不重试)
  VIDEO_REGEX: /(\/Videos\/|\/Items\/.*\/Download|\/Items\/.*\/Stream)/i,
  
  // [新增] 慢接口微缓存 (解决 Resume 1.5s 的问题)
  // 缓存 API 响应 5-10秒，大幅提升"返回/进入"页面的流畅度，同时不影响数据准确性
  API_CACHE_REGEX: /(\/Items\/Resume|\/Users\/.*\/Items\/)/i,
  
  // API超时设置
  API_TIMEOUT: 2500
}

const app = new Hono()

async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

app.all('*', async (c) => {
  const req = c.req.raw
  const url = new URL(req.url)
  // 强制使用 HTTPS 协议回源
  const targetUrl = new URL(url.pathname + url.search, CONFIG.UPSTREAM_URL)
  
  const proxyHeaders = new Headers(req.headers)
  proxyHeaders.set('Host', targetUrl.hostname)
  proxyHeaders.set('Referer', targetUrl.origin)
  proxyHeaders.set('Origin', targetUrl.origin)
  
  // 剔除杂项头
  proxyHeaders.delete('cf-connecting-ip')
  proxyHeaders.delete('x-forwarded-for')
  proxyHeaders.delete('cf-ray')
  proxyHeaders.delete('cf-visitor')

  // 仅缓冲关键非流式交互
  let reqBody = req.body
  if (!['GET', 'HEAD'].includes(req.method) && !url.pathname.includes('/Upload')) {
    reqBody = await req.arrayBuffer()
    proxyHeaders.delete('content-length')
  }

  // --- 判别请求类型 ---
  const isStatic = CONFIG.STATIC_REGEX.test(url.pathname)
  const isVideo = CONFIG.VIDEO_REGEX.test(url.pathname)
  const isApiCacheable = CONFIG.API_CACHE_REGEX.test(url.pathname)
  const isWebSocket = req.headers.get('Upgrade') === 'websocket'

  // --- Cloudflare 策略配置 ---
  const cfConfig = {
    // 1. 静态图片：强力缓存 1 年
    cacheEverything: isStatic,
    cacheTtl: isStatic ? 31536000 : 0,
    
    // 2. API 微缓存：缓存 10 秒 (解决 Resume 接口慢的问题)
    // 注意：只有 GET 请求才会生效 cacheTtl
    cacheTtlByStatus: isApiCacheable ? { "200-299": 10 } : null,

    // 3. 性能优化开关
    // 静态资源：开启有损压缩 (polish) 以加快图片传输
    // 视频资源：彻底关闭所有处理 (off)
    polish: isStatic ? 'lossy' : 'off',
    minify: { javascript: isStatic, css: isStatic, html: isStatic },
    
    // 4. 视频流核心：关闭缓冲
    mirage: false,
    scrapeShield: false,
    apps: false,
  }

  // 如果是 API 微缓存，也需要开启 cacheEverything 才能生效
  if (isApiCacheable) {
    cfConfig.cacheEverything = true
  }

  const fetchOptions = {
    method: req.method,
    headers: proxyHeaders,
    body: reqBody,
    redirect: 'manual',
    cf: cfConfig
  }

  try {
    let response;

    // 视频流 & Socket -> 直连 (无超时，无重试)
    if (isVideo || isWebSocket || req.method === 'POST') {
      response = await fetch(targetUrl.toString(), fetchOptions)
    } else {
      // API & 图片 -> 带超时重试
      try {
        response = await fetchWithTimeout(targetUrl.toString(), fetchOptions, CONFIG.API_TIMEOUT)
      } catch (err) {
        response = await fetch(targetUrl.toString(), fetchOptions)
      }
    }

    // --- 响应处理 ---
    const resHeaders = new Headers(response.headers)
    resHeaders.delete('content-security-policy')
    resHeaders.delete('clear-site-data')
    resHeaders.set('access-control-allow-origin', '*')

    // [关键] 视频流强制关闭连接，防止自动播放卡死
    if (isVideo) {
        resHeaders.set('Connection', 'close')
    }
    
    // [补充] 强制静态图片缓存命中
    // Emby 有时会返回 private 或 no-cache 头，导致 CF 即使配置了 cacheEverything 也不缓存
    // 我们强制覆盖这些头
    if (isStatic && response.status === 200) {
        resHeaders.set('Cache-Control', 'public, max-age=31536000, immutable')
        resHeaders.delete('Pragma')
        resHeaders.delete('Expires')
    }

    if (response.status === 101) {
      return new Response(null, { status: 101, webSocket: response.webSocket, headers: resHeaders })
    }

    // 修正重定向
    if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = resHeaders.get('location')
        if (location) {
             const locUrl = new URL(location, targetUrl.href) // 兼容相对路径
             if (locUrl.hostname === targetUrl.hostname) {
                 resHeaders.set('Location', locUrl.pathname + locUrl.search)
             }
        }
        return new Response(null, { status: response.status, headers: resHeaders })
    }

    return new Response(response.body, {
      status: response.status,
      headers: resHeaders
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: `Proxy Error: ${error.message}` }), { status: 502 })
  }
})

export default app
