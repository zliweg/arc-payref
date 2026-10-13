# Arc PayRef 竞品调研与采用方案

调研日期：2026-09-21（Asia/Shanghai）  
决策：用户已采纳下述三个核心模块。本文保留 2026-09-21 的竞品调研口径；项目现已完成本人双钱包主网小额验收，当前展示材料见 README.md。本文不作为最新竞品复核或主网验收报告。  
证据范围：官方公开资料、公开源码与当前 PayRef 架构核查。竞品资料不等于竞品完整支付验收；市场数据不等于 PayRef 用户需求已获验证。

## 1. 产品判断

PayRef 下一版聚焦业务应收导入、付款差异诊断、可独立复核的对账交接。目标用户仍是已经使用 Arc USDC、能够使用普通 EOA 钱包的个人开发者与小型服务团队。

支付链接、reference、发票、Memo 和 CSV 导出均已有对标。不能声称这些功能由 PayRef 首创，也不能把官网未提到某功能解释成竞品一定没有。竞争力需要体现为更少的手工核对、更准确的差异识别和更顺畅的资料交接。

## 2. 市场数据与限制

| 数据 | 来源与口径 | 能说明什么 |
| --- | --- | --- |
| 2025 年可观察的商品和服务稳定币支付约 3,500亿—5,500亿美元 | [BCG / Allium](https://www.allium.so/reports/stablecoin-payments-the-truth-behind-the-numbers)，行为分类估计，排除部分链下活动 | 稳定币商业支付有现实规模；不是把所有链上转账都当作支付 |
| 服务 4,000 多家企业与自由职业者、处理超过 1 亿美元 | [Acctual 厂商披露](https://www.acctual.com/blog/get-paid-same-day)，未经本项目独立审计 | 与 PayRef 类似的账单收款需求已有商业产品承接 |

尚未取得 Arc 目标用户数量、月均账单量、对账耗时或付费意愿的数据。上述宏观数字不是 PayRef 的可服务市场规模。产品开发和模拟测试不能替代真实用户验证。

## 3. Arc 的底层对标与应用参考

| 对象 | 定位 | 可借鉴内容 |
| --- | --- | --- |
| [Tempo](https://tempo.xyz/) | 支付导向 L1，具备稳定币费用和付款 metadata | 付款 reference 与业务系统衔接；这些底层概念并非 Arc 独有 |
| [Plasma](https://www.plasma.org/docs/get-started/why-build-on-plasma/overview) | 面向稳定币支付和金融产品的 EVM L1 | 支付产品所需的完整运营能力，而不只是 token transfer |
| Base / Ethereum / Polygon | 有成熟支付应用的生态 | 商户工作台、付款链接、财务导出 |
| Solana / [Solana Pay](https://docs.solanapay.com/spec) | 公链 / 支付协议与 SDK，二者不是同一层产品 | 每笔订单的 reference、支付链接、二维码、找到交易后仍需验证实际 transfer |
| Stellar / [SEP-7](https://developers.stellar.org/docs/build/apps/wallet/sep7) | 支付网络 / 钱包支付 URI 标准 | 支付请求、memo、签名 URI；其域名密钥机制不等于 PayRef 收款钱包签名 |

## 4. 竞品能力与采用判断

| 产品 | 已核实的公开能力 | 对 PayRef 的采用判断 |
| --- | --- | --- |
| [FlowPay](https://www.flowonarc.net/how-to-work) | 链上账单、精确金额、截止、已付款状态和取消；[合约](https://github.com/dlkakbs/FlowPay/blob/main/src/ArcInvoice.sol)拒绝再次支付已付账单 | 借鉴生命周期。其合约防重复付款强于本地窗口互斥，不能靠 UI 按钮复制 |
| [SubScript](https://www.subscriptonarc.com/protocol) | intent、hosted checkout、收据、签名 webhook 和事件处理 | 借鉴业务编号与支付事件贯穿流程。持续通知、履约依赖后端 |
| [QianPay](https://docs.qian.ag/qianpay) | 无账户固定金额链接、钱包签名、账单明细、due date、付款后回执 | 借鉴商业账单体验；[网络资料](https://docs.qian.ag/contracts)仍将 Base 与 Arc testnet 区分 |
| [Arqis](https://www.arqis.site/docs/seller-console.html) | 付款人 inbox、收款工作台、业务编号、通知 | 借鉴应收与应付分开；[安全文档](https://www.arqis.site/docs/security-verification.html)已有后台核验流程，但仍是测试网 MVP，生产检查尚未全部完成 |
| [Request Network](https://docs.request.network/api-features/payment-detection) / [Request Finance](https://help.request.finance/en/collections/8833002-exports) | reference 付款检测、实际金额与收款方校验、业务单据和财务导出 | 借鉴单据→到账→对账→财务交接。API 与持续监控不适合直接放入静态前端 |
| [Acctual](https://www.acctual.com/stablecoin-invoicing) | 明细、客户、品牌账单、回执、会计系统同步 | 先借鉴可读账单和交接方式，完整会计系统同步暂缓 |
| [Stripe](https://docs.stripe.com/payments/stablecoin-payments) | 多网络稳定币付款接入 Payment Links / Invoicing，清晰付款状态、完成通知和退款 | 借鉴付款摘要与下一步；账户结算和退款能力不可仅通过移植界面获得 |
| [MoonPay Commerce](https://support.moonpay.com/en/articles/466267-moonpay-commerce-faqs)，原 Helio | 支付链接、交易管理、CSV、二维码、嵌入付款与 webhook | 借鉴工作流；服务端密钥不能放在浏览器中 |
| [StablePayOps](https://www.hxcarbon.com/) | 批量导入、异常队列、人工业务说明和审阅材料 | 这些单项不是空白。当前公开网络选项未见 Arc；月结包同页既有入口又标 Planned，成熟度未验证 |
| [tempo-reconciliation-sdk](https://github.com/valpaq/tempo-reconciliation-sdk) | 结构化 Memo、监听、预期账单匹配、CSV/JSON/webhook，TS/Rust 实现 | 直接开源对标。作者自定规范不是 Tempo 官方标准；README 主网 RPC 仍写 TBD，生产采用未核实 |

Request Network、Stripe 等所查网络列表未列 Arc，不能把这些产品写成已可直接接入 Arc。对标以工作流为主；不自动引入跨链、订阅、托管、服务端或新资金合约。

## 5. 重要技术修正与相对差异

SubScript 的[当前链上文档](https://docs.subscriptonarc.com/docs/contracts.md)说明：商户付款通过自建 Router 的 `DepositWithMemo` 关联收据，个人 receive link 是普通 USDC transfer。这不等于使用 Arc 固定原生 Memo 合约。其[收据文档](https://docs.subscriptonarc.com/docs/receipts.md)把默认可见范围设为付款人、商户和平台，第三方邀请仍为未来流程。

PayRef 的原生 Memo 依据来自 [Arc 官方文档](https://docs.arc.io/arc/concepts/transaction-memos)。潜在组合价值是：原始业务应收、收款钱包签名请求、真实转账与查询覆盖范围一同交接，另一人无需原平台账户即可重新核验。

在本轮核查的四家 Arc 竞品资料中，未找到明确完整描述这种可迁移交接流程的说明。这是有限样本内的发现，不是“竞品一定没有”或“全球首创”的证明。FlowPay 在链上防重复付款方面有不同且更强的保证，PayRef 不宣称整体更安全。

## 6. 已采用的实施范围

### 6.1 业务应收与三方对照

- 从 CSV / JSON 导入业务编号、精确 USDC 金额、客户备注和可选 requestId / hash，先显示逐行校验预览再合并。
- 业务记录是未签名本地声明，不能直接变成签名请求；需要关联既有请求，或逐条连接收款钱包创建并签名新请求。
- 只有明确 requestId 等强关联可用于匹配。同金额、同地址、同编号只能提供候选，需人工选择，不能据此宣称付款成功。
- 分别展示业务账单与签名请求是否一致、付款是否严格核验、查询是否完整。
- 例：业务应收 100 USDC，签名请求 80，实际付款 80。付款可通过请求核验，但业务账单必须保留 20 USDC 的差异，不以一个“已付款”掩盖。
- 合并保留原记录，重复标识冲突显式报告；支持完整业务记录导出恢复和安全 CSV。

### 6.2 异常诊断与处理

- 解释重复款、金额或地址不符、缺少 Memo、未决交易、查询不完整。
- 将预期与实际并列，给出证据范围与下一步，使用既有唯一付款核验器判定成功。
- 普通 USDC 转账可显示观察事实，但无匹配 Memo 时不能升级为 PayRef 已核验付款。
- 人工处理状态与备注和链上事实分开；“已处理”不修改链上核验结论，不自动补付、重发或退款。

### 6.3 对账交接与独立复核

- 导出有版本的交接包，包含业务记录、完整签名请求、交易标识、核验规则版本、历史查询范围、异常与人工说明。
- 提供可读汇总、独立浏览器复核和命令行复核入口；无需将外来包写入本地账户。
- 所有历史结论均为不可信快照；重新验签并联网查询，分别报告单笔付款核验和全范围重复检查。
- 支持逐条错误、部分成功、取消和未执行，不能把原始 RPC 文件当作离线主链证明。

### 6.4 便利功能与暂缓项

付款前保存到本地、应收与应付分类、链接二维码作为便利功能补齐。结构化且受签名保护的账单明细涉及 v2，暂不修改 v1。后台催款、云同步、自动退款、部分付款、链上撤销与合约级防重复付款暂缓。

## 7. 验收和市场验证

工程验收覆盖金额精度、CSV 引用和公式注入、字段篡改、错误网络、重复标识冲突、查询失败、取消、存储损坏、跨页面与刷新、干净浏览器复核，以及全部新入口与按钮。

市场验证建议：准备 10 条应收与 8 笔测试付款数据，包含正常、重复、错金额、无 Memo 和未找到付款；请有稳定币经验的人分别使用表格＋浏览器与 PayRef 完成对账和交接。记录输入准备、字段整理、核对、导出在内的总时间、误判和交接成功率。

目标是没有错误的“已核验”判定，第三方可复查，以及显著减少总操作时间。这些是验收目标，不是已取得的用户调研结果。主要风险是外部账单缺少 requestId，人工关联成本抵消导入收益，导致维护两套账。

真实 MetaMask 写入、主网支付与真实用户价值验证必须分别报告；本调研阶段（2026-09-21）未进行主网操作，后续主网证据见 README.md。模拟端到端测试不能作为真实链上付款验收。
