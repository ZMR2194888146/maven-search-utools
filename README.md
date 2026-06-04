# Maven 依赖搜索

一款 [uTools](https://www.u.tools/) 插件，用于快速搜索 Maven 中央仓库依赖，一键复制 `<dependency>` XML 片段。

## 功能

- **关键词搜索** — 输入 groupId 或 artifactId 即可搜索 Maven 中央仓库
- **一键复制** — 点击搜索结果自动复制标准 `<dependency>` XML 到剪贴板
- **相似搜索** — 按 groupId 查找同一组织下的其他依赖
- **版本信息** — 展示最新版本号和历史版本数量

## 使用方式

1. 在 uTools 中输入 `mvn` 触发插件
2. 也支持正则匹配：输入 `mvn <关键词>` 直接进入搜索（如 `mvn spring-boot`）
3. 在搜索框中输入关键词，结果会自动加载
4. 点击任意结果条目即可复制 dependency XML
5. 悬停条目后点击「相似搜索」可查找同一 groupId 下的其他包

## 开发

### 前置要求

- [uTools](https://www.u.tools/) 桌面客户端
- uTools 开发者工具（在 uTools 中输入 `开发者工具` 打开）

### 本地调试

1. 克隆本仓库
2. 在 uTools 开发者工具中选择「加载本地插件」，指向项目根目录
3. 插件将自动读取 `plugin.json` 配置并加载

### 项目结构

```
mvn-search/
├── plugin.json              # uTools 插件配置
├── package.json
├── assets/
│   ├── logo.png             # 插件图标
│   └── logo.svg
└── src/
    ├── background/
    │   └── index.js         # 后台逻辑（Preload 脚本）
    └── frontend/
        └── index.html       # 前端界面
```

## 性能优化

- **HTTPS Keep-Alive** — 复用 TCP/TLS 连接，减少握手开销
- **LRU 内存缓存** — 缓存最近 100 条搜索结果（TTL 5 分钟），避免重复请求
- **字段裁剪** — 仅请求所需字段，减少响应体积
- **请求取消** — 新请求自动终止上一次未完成的请求，防止结果覆盖

## 数据来源

搜索数据来自 [Maven Central Repository Search API](https://search.maven.org/) (Solr)。

## License

MIT
