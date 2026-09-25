# Tasks — add-hang-watchdog

## 1. 计时与标记

- [x] 1.1 `src/watchdog.ts` 计时表与单例 interval 扫描器（80% 预警 / 阈值处置 / `acted` 单次标志 / dispose 清空；`off` 模式完全惰性）；验证：`tests/watchdog.test.mjs` 用 fake 时钟覆盖预警、处置、单次性、清除
- [x] 1.2 `plugin.ts` 接线 `shell.env`（注入 `FORGE_WATCHDOG_MARK=<namespaced callID>`）与 `tool.execute.before/after`（shell/bash 两名都记）；验证：接线单测断言标记注入与记录生命周期

## 2. 进程定位与处置

- [x] 2.1 `src/proc-locate.ts`：POSIX `/proc/*/environ` 精确匹配 + Windows 宿主子孙树 × CreationDate ≥ t0 推算，统一 `locate(callID, t0)` 接口可注入 fake；验证：单测覆盖两路（含"早于 t0 的进程被排除""宿主树外进程被排除"）
- [x] 2.2 处置引擎：`locate` → 杀树（复用/自带 `src/proc.ts` 肌肉）→ 账本条目（warn/kill/unresolved 三事件、命中清单、观察窗后仍无 after 的 unresolved 上报）；验证：单测用 fake locate/kill 覆盖三分支
- [x] 2.3 `watchdog.mode` 三态（off 不启扫描、dry-run 只记录命中清单不杀、kill 全量）；验证：单测覆盖三态行为矩阵

## 3. 账本与配置

- [x] 3.1 诊断账本（JSONL、有界轮转删旧、条目含 callID/session/tool/t0/事件/进程清单）；验证：单测断言结构、上限、轮转
- [x] 3.2 配置面：`watchdog.mode` / `watchdog.stallMs`（最小保护值 clamp）；验证：config 解析单测（非法值回退默认并记账）

## 4. 降级与边界

- [x] 4.1 shell.env 钩子失效探测（标记未注入时自动降级 dry-run 并记账）；验证：单测模拟钩子缺失路径
- [x] 4.2 与 job-supervisor 的互斥（forge_shell 的 spawn 不带标记、job 不受管辖）；验证：若 add-job-supervisor 已 apply，集成断言 job 进程无标记；未 apply 则单测断言标记注入仅走 shell.env 钩子

## 5. 文档

- [x] 5.1 README：watchdog 章节（三态、阈值、Windows 推算的并发残余风险、退役指引）、文件账本加 watchdog 目录、卸载覆盖；验证：按避坑 §6 口径核对账本三块
- [x] 5.2 AGENTS.md 架构表加 watchdog/proc-locate 行；验证：与实际模块一致

## 6. 实机验证

- [x] 6.1 #47350 repro（内置 shell 跑持管道的 detached launcher）触发哨兵：kill 模式下击杀解锁、账本可查；dry-run 模式只记录；验证：两种模式行为符合 spec
- [x] 6.2 双平台定位器实机验证（Windows 推算 + POSIX environ 各一轮）；验证：命中清单准确、无误杀
- [x] 6.3 子代理会话路径：子代理内内置 shell 挂死同样被解锁；验证：父层 task 调用在处置后返回

## 7. 发布门槛

- [ ] 7.1 `bun build` 打包、dist 入库、版本（与 add-job-supervisor 同车 0.3.0，后到递增 patch）、npm 发布；验证：`npm pack` 产物检查
- [ ] 7.2 官方安装模式终验（发布后，npm spec 模式）：`opencode plugin @sorenllm/opencode-forge --global`（npm registry 名安装）装上后冒烟（dry-run 模式跑一次正常命令零干扰）全过；与 add-job-supervisor 8.2 的同一发布列车共用"npm plugin 模式 + 测试通过"的最终状态硬性要求
