# README 参照记录

`readme-forge` 阶段二的产出。参照只用标题骨架, 正文没有进入 `README.md`。

## 取的参照

```
node ref-harvest.mjs --local <plugin dir>
```

| 参照仓库 | 标题序列 |
| --- | --- |
| `@mars-sea/dsh-commandcode-provider` | title > install > features > demo > api > usage > config > license |
| `dsh-cost-meter` | title > features > usage > ack > demo > install > license |
| `dsh-deja` | title > install |

频率: title 3/3, install 3/3 (REQUIRED); features 2/3, usage 2/3, demo 2/3, license 2/3; api 1/3, config 1/3, ack 1/3 (rare)。

## 定下的骨架

title > 安装 > 用法 > 设置界面 > 配置 > 多账号轮转 > 已知限制 > 开发 > 许可证

## 舍弃的参照章节

- `demo`: 舍弃。用法靠可复制的配置片段和模型表说明, 没有可公开录制的会话。
- `ack`: 舍弃。事实卡里没有致谢来源。
- `api`: 合并进 "配置" 与 "设置界面"。对外面只有 provider id、config 字段和 `river` Remote 命名空间, 单开一节会把同一张表抄两遍。
- `features`: 拆进 "用法" 与 "多账号轮转"。罗列功能会写成形容, 换成行为描述。
