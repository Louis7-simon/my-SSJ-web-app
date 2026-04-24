# LOUIS的超级助理

移动端优先的 AI 语音事项管理网页应用。现在项目已经升级为前后端一体：

- 前端：Vite + React
- 后端：Express
- 数据库：SQLite，默认文件为 `data/suishiji.db`
- AI：云雾 API，使用 `.env` 中的模型和 Key

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
- 浏览器语音输入
- AI 自动拆分、分类并保存事项
- 后端 SQLite 持久化保存事项
- 事项按时间或分类查看
- 搜索、完成、修改、删除、延期到明天
- 每日 AI 总结：事务报告、日程规划、执行建议
- 每日总结保存到数据库，避免重复生成
- 页面打开期间支持浏览器通知提醒

## 环境变量

参考 `.env.example`：

```text
YUNWU_API_KEY=
YUNWU_MODEL=
YUNWU_API_BASE_URL=https://yunwu.ai/v1
DATABASE_PATH=data/suishiji.db
API_PORT=3001
```

## 生产运行

```bash
npm run build
npm run start
```

生产模式下，Express 会托管 `dist/` 前端构建产物，并继续提供 `/api/*` 接口。
