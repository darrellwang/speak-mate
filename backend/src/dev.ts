/**
 * 本地开发入口（pnpm dev）。
 *
 * 在加载 config/env 之前把 NODE_ENV 设为 development。
 * 不在 package.json 里写 `NODE_ENV=development tsx ...`：Windows 的 cmd 不认这种写法。
 */

process.env.NODE_ENV = 'development';

await import('./index');

export {};
