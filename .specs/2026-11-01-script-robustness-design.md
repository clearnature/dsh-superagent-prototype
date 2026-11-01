# 2026-11-01 scripts/dsh-superagent 健壮性移植设计

来源：fork 提交 4bc6531（hxh230802）中可自移植部分；背书：fork 实测踩坑记录。
原则：自包含、有 fork 验证背书、Linux 行为不回退。纯脚本层，不碰 src/。

## 目标

修 scripts/dsh-superagent 三个健壮性缺陷：

1. **URL 解析链**：健康检查地址写死 `127.0.0.1:3082`。改为
   `--url`/`DSH_SUPERAGENT_URL` → `control/<profile>/url.txt` → 最近 3 个启动日志的
   `dsh web:` 行 → 默认 3082。status/stop/start 统一走 `service_url(args)`。
2. **启动后 URL 发现**：start 后 20s 内轮询新日志抓 `dsh web:` 地址，写 `url.txt`、
   打印 `URL:`；健康等待收尾打印 `Panel: <url>/`。
3. **state lock 等待**：start 前若 `<stateDir>.lock` 存在且 mtime 距今 <30s
   （runtime stale 窗口），逐秒等待至陈旧，45s 超时报可执行提示。

## 非目标（不移植）

- Windows netstat/tasklist 进程认领（Linux 无用；`processes()` 签名不变）
- fork 的 `seed_policy`、`is_web_profile` 模板校验（fork 特有流程）

## 关键实现点

- `configured_state_dir()`：正则读 profile patch 的 `stateDir:`；解析不到返回 None →
  等待逻辑静默跳过（保守降级，与现状一致）。
- `log_url()`：按 mtime 取最近 3 个日志倒序找 `dsh web:\s*(https?://\S+)`，截断 `/?` 后缀。
- 不改任何命令行接口与输出 JSON 的既有字段；只新增 `URL:`/`Panel:` 打印与 url.txt。

## 验证

- 场景单测：伪造 control/log 工件，`python3 -c` 直调函数验证三级解析、lock 等待分支。
- 冒烟：对不存在的 profile 跑 `status`，确认 URL 回退默认值且输出结构不变。
