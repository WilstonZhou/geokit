import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // 不再对 /api/* 设置 Access-Control-Allow-Origin: *。
  //
  // GEOkit 默认只监听 127.0.0.1（见 package.json 的 dev/start 脚本），
  // 浏览器 UI 与 API 同源，不需要 CORS。通配 CORS + 无鉴权会让任意网页
  // 读取 Observation / GSC 数据并触发服务端抓取。若确实需要跨源访问，
  // 请在反向代理层显式配置允许的 Origin，不要在这里放开 *。
};

export default nextConfig;
