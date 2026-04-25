# LOUIS的超级助理

移动端优先的 AI 语音事项管理网页应用。项目现在是前后端一体：

- 前端：Vite + React
- 后端：Express
- 线上数据库：PostgreSQL，推荐 Railway PostgreSQL
- 本地兜底数据库：SQLite，默认文件为 `data/suishiji.db`
- AI：云雾 API
- 语音识别：阿里 DashScope / FunASR 实时 ASR

## 运行

```bash
npm install
npm run dev
```

打开：

```text
http://localhost:5173
```

后端 API 默认运行在：

```text
http://localhost:3001
```

## 当前功能

- 文字快速记录
- 按住说话式语音录入
- FunASR 实时语音识别
- AI 自动拆分、分类并保存事项
- 事项按时间或分类查看
- 搜索、完成、修改、删除、延期到明天
- 每日 AI 总结：事务报告、日程规划、执行建议
- 每日总结保存到数据库，避免重复生成
- 页面打开期间支持浏览器通知提醒

## 环境变量

参考 `.env.example`：

```text
YUNWU_API_KEY=
YUNWU_MODEL=gpt-5.4-mini
YUNWU_API_BASE_URL=https://yunwu.ai/v1
FUNASR_API_KEY=
FUNASR_MODEL=fun-asr-realtime
DATABASE_URL=
DATABASE_PATH=data/suishiji.db
API_PORT=3001
```

## Railway 数据库方案

为了避免每次部署后数据丢失，线上建议使用 Railway PostgreSQL，而不是依赖容器文件系统。

在 Railway 里添加 PostgreSQL 数据库后，把数据库提供的 `DATABASE_URL` 配置到当前 Web 服务的 Variables 里。应用启动时会自动判断：

- 如果存在 `DATABASE_URL`：使用 PostgreSQL，数据不会因为重新部署丢失
- 如果不存在 `DATABASE_URL`：使用 SQLite，本地开发会写入 `data/suishiji.db`

配置后可以访问：

```text
https://你的域名/api/env-check
```

如果返回里看到：

```json
{
  "databaseProvider": "postgres"
}
```

就说明线上已经切换到 PostgreSQL。

## 生产运行

```bash
npm run build
npm run start
```

生产模式下，Express 会托管 `dist/` 前端构建产物，并继续提供 `/api/*` 接口。
