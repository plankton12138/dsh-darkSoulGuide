# 黑魂攻略助手 · dsh-darksouls-guide

一个能**读你存档**的《黑暗之魂3》攻略助手。它知道你打到哪、杀了谁、还差哪些篝火和戒指，然后回答「接下来该干什么」。

> 状态：**0.8.0**。六条收集轴、四个模型工具、独立 Agent 预设、输入框进度药丸。已在 DSH 里读出真实进度。设计见 [docs/blueprint.md](docs/blueprint.md)。

## 装好之后怎么用

**新建会话时选「黑魂3 攻略」预设。** 这是关键——工具、人格和存档上下文都只在该预设里生效，其他会话完全不受影响。

对话里输入框工具栏左侧有一颗**进度药丸**（`Lv103 · 传火祭祀场`），点开是六条进度轴和快捷提问，芯片点一下就把问题写进输入框。它只占工具栏里的一个控件，不额外占用垂直空间：

| 芯片 | 会问 |
|---|---|
| 下一步干嘛 | 我现在该去哪儿？ |
| 还缺什么 | 我全收集的话还缺什么？按能补的数量排一下。 |
| 配装建议 | 按我现在的属性和装备，怎么调整比较好？ |
| 加点 | 我接下来该往哪个方向加点？ |

左侧栏还有一页**进度图**：19 个区域的连通关系、篝火完成度、「下一步」建议。这一页不需要预设，随时可看。

**页面上的每个数字都能点。** 快捷提问芯片、地图上未点亮的区域、成就里缺失的具体物品——点一下，问题就填进输入框，你看过再发送。

## 它现在能回答

| 问题 | 靠什么 |
|---|---|
| 我什么流派、该怎么加点 | `character`（九项属性） |
| 我打到哪了、玩了多久 | `progress` + `bosses` |
| 还有哪些 Boss 没打 | `bosses`（24 个主线 + DLC 主要 Boss） |
| 我漏了哪些篝火 | `bonfires`（81 个，按区域） |
| 我还差哪些戒指、法术、誓约 | `ds3_overview`（按背包 ID 判定） |
| 现在能立刻拿到什么 | `ds3_overview` 的可达性分类（未交换的 Boss 灵魂、教团还差几枚） |
| 成就还差哪些 | `ds3_overview` 的成就清单（只报存档能验证的 5 项） |
| 这个物品在哪 | `ds3_sources` 给出可核对的攻略页链接（不转载正文） |
| 我身上穿的什么 | `equipment` |
| 我有哪些钥匙和关键道具 | `inventory` |
| 接下来按什么顺序走 | `ds3_plan_route`（已区分传送与步行） |

**进度按缺口报，不按百分比报**：「戒指 37/74」能推出还差 37 枚，「50%」不能。戒指按**家族**计数（+1/+2/+3 不算新戒指），避免把变体当成多个收集品。

## 它不做什么

- **不写存档**。只读。写回要重算 MD5 与 AES，在线模式有封禁风险。
- **不联网拉攻略**。游戏知识走本地 `data/reference/`。
- **还没有区域内导航**。「缺哪块」能答，「从哪个门进去」还答不了。
- **不承诺全成就**。戒指/法术/誓约能从存档验证，但成就还含姿势、动作、强化上限等读不全的项。
- **不猜**。存档里看不到的，它会说看不到。

## 先跑一下解析器

不需要装插件，Python 3 + `cryptography` 就能验证整条解析链路：

```powershell
pip install cryptography
python tools\ds3\dump_save.py          # 人类可读
python tools\ds3\dump_save.py --json   # GameState 形状
```

输出形如：

```
槽 0  'plankton'  Lv 103  souls 22765
  VIG 32  ATN 6   END 40  VIT 13
  STR 33  DEX 40  INT 8   FTH 9   LCK 11
  时长 24.9 小时   最后休息：传火祭祀场
  Boss 已击败 22：灰烬审判者古达、冷冽谷的波尔多、…
  Boss 未击败 2：老恶魔王、守墓人
```

## 在 DSH 里安装

```powershell
# 通过插件管理器安装本目录（bundle 形式）
plugin_manager install_bundle target=<本目录绝对路径>
```

装好后对模型说「我黑魂3练的什么流派」「我还有哪些篝火没点」即可。

**第一次打开没有存档会看到什么。** 面板会显示找不到存档，并告诉你去哪找：

```
读不到存档：没有找到《黑暗之魂3》存档
默认查找 %APPDATA%\DarkSoulsIII\*\DS30000.sl2 —— 请确认游戏至少创建过一个角色并保存过。
```

需要 Python 3 和 `cryptography`；缺哪个会分别提示，而不是只说「读不到」。

## 目录导航

| 路径 | 作用 |
|---|---|
| [docs/blueprint.md](docs/blueprint.md) | **架构、存档格式、里程碑、已知局限**（从这里开始读） |
| [docs/research/](docs/research/) | 同类项目（Savecraft / ds3-advisor）的设计参考 |
| [src/tools/ds3.js](src/tools/ds3.js) | 三个模型工具 |
| [src/state/route.js](src/state/route.js) | 区域连通图寻路 |
| [src/parsers/ds3/run.js](src/parsers/ds3/run.js) | 子进程封装、错误分类、缓存 |
| [tools/ds3/dump_save.py](tools/ds3/dump_save.py) | 存档解析器（独立可跑） |
| [data/reference/ds3/](data/reference/ds3/) | 物品表、篝火表、区域连通图 |
| [tests/fixtures/](tests/fixtures/) | 存档夹具，回归用 |

## 环境要求

- Windows + PC 版 Dark Souls III（存档在 `%APPDATA%\DarkSoulsIII\<SteamID>\DS30000.sl2`）
- Python 3 + `cryptography`（解析器依赖）
- DSH 0.2.x

## 致谢与许可说明

存档容器与加密格式来自 [DS3SaveUnpacker](https://github.com/tremwil/DS3SaveUnpacker)（MIT）。
旗标编码、装备/背包偏移、物品名称表参考 [ds3-advisor](https://github.com/mozartdiniz/ds3-advisor)（该项目**未发布许可证**）——本项目只采用其中的**格式事实**（偏移、编码规则、游戏数据），代码为独立实现。

## 授权

代码：[MIT](LICENSE)。

游戏数据与商标说明见 [NOTICE.md](NOTICE.md)。

**本仓库不含任何存档文件、Steam 账号信息或游戏资源。** 存档属于个人数据，相关路径已在 .gitignore 中永久排除。

## 自检

面板读不到存档时，先跑冒烟测试定位是「路由没注册」还是「解析失败」：

```powershell
node tests\smoke-progress.mjs http://127.0.0.1:<端口>
```

它区分三种失败：连不上（应用没开）、404（路由未注册——通常是 `webServer` 没注入）、空响应体（处理器崩溃）。**这三种在界面上都可能显示成同一句 `Unexpected end of JSON input`。**
再跑一条，验证没有存档时的提示是否可执行：

```powershell
node tests\no-save.mjs
```