import { readFileSync, writeFileSync } from 'fs';

const d = JSON.parse(readFileSync('./output/scored-candidates.json', 'utf8'));

// Agent 1 results (indices 1-5)
// Agent 2 results (indices 6-10)
// Agent 3 results (indices 11-15)
// Agent 4 results (indices 16-20)

const agentResults = [
  // Agent 1 - from completed notification
  {index: 1, score: 28, comment: "技术栈匹配：掌握Java与Python，熟悉RAG、LangGraph、Spring AI等AI框架，具备知识库检索与Prompt工程实践，但缺乏Dify、意图识别、OpenCode/ClaudeCode、AI IDE工具及next.js/Django/Tornado等框架经验 | 项目经验相关性：有OceanBase ODC智能问答助手项目（基于PowerRAG构建企业级智能答疑系统），涉及混合检索调优、Prompt工程与防幻觉机制，与智能客服场景部分相关；主要背景为Java后端开发与数据库工具开发，Agent搭建经验不足 | 行业经验：数据库工具与后端开发行业背景，与AI应用开发岗位方向存在差距，缺乏智能客服/数字员工Agent相关经验"},
  {index: 2, score: 44, comment: "技术栈匹配：精通Python与Java，深度掌握LangChain、LangGraph、RAG等AI框架，有Coze/Dify/n8n等平台集成经验，熟悉Claude Code/Codex等AI编程工具，具备Prompt Engineering、Function Calling、Agent Workflow全栈能力；对知识库问答评测（EvalScope、RAGAS）有实战经验；但未明确提及RAGFlow、next.js/Django/Tornado | 项目经验相关性：主导LC智能问答平台（RAG+LangGraph+知识图谱）、LC AI工作台（Agent Workflow+Skill封装）、安全调研报告自动生成系统（Coze工作流）等高度匹配项目，覆盖智能问答、Agent搭建、内容生成等岗位职责场景，具备从方案设计到上线交付的完整经验 | 行业经验：大模型应用工程化背景与企业级AI产品经验与AI应用开发岗位高度契合，具备AI应用场景识别与落地能力"},
  {index: 3, score: 16, comment: "技术栈匹配：掌握Python和SQL，但核心技能为大数据技术栈（Flink、Spark、StarRocks、Trino等），未涉及RAGFlow、Dify、LangChain等AI应用框架，缺乏意图识别、Agent搭建、AI IDE工具和next.js/Django/Tornado等岗位必备技能 | 项目经验相关性：主要从事数据中台建设、异构数据迁移、数据建模等数据工程工作，虽提到AI知识库数据底座构建，但偏数据基础设施层面而非AI应用层开发，无智能客服、Agent或智能问答系统直接开发经验 | 行业经验：金融与高端制造行业数据平台建设经验丰富，但行业方向为数据工程而非AI应用开发，与AI应用开发工程师岗位的直接经验差距较大"},
  {index: 4, score: 22, comment: "技术栈匹配：熟悉Python、FastAPI、LangChain、RAG框架，有Dify低代码平台使用经验，具备基础Prompt工程能力，掌握MySQL/Milvus等数据库；但缺乏意图识别、知识库问答评测、OpenCode/ClaudeCode、AI IDE工具及next.js/Django/Tornado等经验，技术栈宽度不足 | 项目经验相关性：有基于Dify的大模型学术论文筛查项目经验（涉及workflow编排与RAG），以及LangChain文本对比功能迁移优化，与AI应用开发方向初步对口但深度较浅；全栈开发能力主要来自佣金管理系统等传统业务项目，Agent搭建与智能问答系统经验缺乏 | 行业经验：大模型应用开发实习背景，方向正确但以客户Demo快速落地为主，尚未涉及企业级智能客服或数字员工Agent等复杂场景"},
  {index: 5, score: 38, comment: "技术栈匹配：精通Python与Java，深入掌握LangChain、LangGraph、FastAPI、Spring Boot+LangChain4j等AI框架，有Coze低代码平台使用经验，具备RAG（Qdrant/ES/Pinecone向量检索）、Function Calling、Agent Workflow、Prompt工程等核心能力，熟悉DeepSeek等大模型接入；但未提及RAGFlow、OpenCode/ClaudeCode、AI IDE工具及next.js/Django/Tornado | 项目经验相关性：主导智数通NL2SQL智能体项目（基于LangGraph Agent工作流+多路RAG召回）、宁医智诊医疗助手（LangChain4j+RAG+Function Calling）、灵感成片Coze工作流等多个智能体项目，覆盖Agent搭建、RAG知识库、工具调用等岗位核心职责，智能问答与Agent交付经验丰富 | 行业经验：多个AI智能体项目从设计到上线的完整交付经验，与AI应用开发岗位的智能客服平台搭建、数字员工Agent部署等职责高度对口"},

  // Agent 2 - from completed notification
  {index: 6, score: 8, comment: "技术栈匹配：候选人背景为产品经理，熟悉LLM大模型应用、Prompt工程和Agent机制设计概念，但缺乏RAGFlow、Dify、LangChain等AI应用框架的实际开发使用经验，也不具备Python/JAVA编程语言和next.js/Django/Tornado等技术框架的实际编码开发能力。 | 项目经验相关性：项目经验集中于AI产品定义、需求分析和交互设计（智能考试测评系统、AI协同开发工作台），而非AI应用系统的工程化开发与调优，缺乏智能客服平台、智能体部署等与JD职责直接相关的项目实战。 | 行业经验：AI产品经理背景，对AI应用趋势有一定认知，但行业经验偏向产品侧而非技术研发侧，与AI应用开发工程师的技术开发定位不匹配。"},
  {index: 7, score: 22, comment: "技术栈匹配：熟悉Python编程语言，有LangChain框架构建RAG系统的实际经验，使用过Qwen大模型和FastAPI后端框架，具备LangGraph工作流编排经验。但缺乏RAGFlow、Dify等AI应用框架经验，未体现next.js/Django/Tornado等Web框架使用经历，也不具备全栈(前端+后端)开发能力。 | 项目经验相关性：云链合同风险检索项目涉及RAG知识库构建、LangChain流程编排、文档解析与向量化检索，与JD知识库问答评测调优要求有部分契合。但主要项目经验集中在推荐系统和金融风控领域，缺乏智能客服平台、数字员工Agent搭建与调优等与JD职责直接相关的项目经验。 | 行业经验：金融行业算法工程师背景，有AI技术应用经验，以数据处理和模型训练为主，缺少AI应用框架工程化开发和智能体部署运营的行业实践。"},
  {index: 8, score: 12, comment: "技术栈匹配：简历文本为乱码，无法获取候选人的技术栈信息。仅从基本信息可知为大模型算法方向，无法确认是否熟悉RAGFlow、Dify、LangChain等AI应用框架及Python/JAVA等编程语言。 | 项目经验相关性：简历文本损坏，无法评估项目经验的具体内容，无法确认是否有智能客服平台搭建、Agent部署运营等与JD相关的项目经历。 | 行业经验：基础信息显示为大模型算法工程师，推测有一定AI行业背景，但简历文本不可读导致无法准确评估行业经验的匹配程度。"},
  {index: 9, score: 5, comment: "技术栈匹配：熟悉JAVA编程语言和SpringBoot/SpringCloud等后端框架，与JD要求熟悉Python或JAVA等至少一门高级语言部分匹配。但完全缺乏RAGFlow、Dify、LangChain等AI应用框架经验，也未见next.js、Django、Tornado等Web框架使用经历，不具备全栈开发能力和AI IDE工具使用经验。 | 项目经验相关性：项目经历为国家气象局人工影响天气系统等传统Java后端业务系统，无任何智能客服平台、Agent搭建、知识库问答等与AI应用开发相关的项目经验。仅提到负责部门AI工具培训推广，但缺乏实质性的AI项目开发实践。 | 行业经验：传统Java后端开发行业背景，以工业互联网、政务系统为主，缺乏AI应用开发和智能体部署运营的行业经验。"},
  {index: 10, score: 38, comment: "技术栈匹配：精通JAVA编程语言，熟练使用SpringBoot+MyBatisPlus+Redis+Vue3全栈技术，有对接deepseek、qwen3等大模型的实际经验，使用过LangChain4j进行AI应用开发。具备全栈开发能力（SpringBoot后端+Vue3前端），符合JD中JAVA语言和全栈能力要求。但缺少RAGFlow、Dify、next.js、Django等框架的直接使用经验。 | 项目经验相关性：智能体平台项目经验与JD高度匹配，涉及机器人管理、意图管理、提示词管理、知识库管理、RAG问答等核心模块，与JD要求智能客服平台搭建和Agent skill智能体搭建直接对应。个人小程序(西米AI工具宝)独立完成全栈开发和云部署，体现了AI应用工程化的完整能力。具备对话智能体平台架构设计与开发经验。 | 行业经验：在特斯联智能科技从事AI应用开发，涉及智能体平台、低代码平台等AI应用方向，有丰富的Java全栈开发经验与AI技术落地实践，行业经验与AI应用开发工程师高度匹配。"},

  // Agent 3 - from completed notification
  {index: 11, score: 34, comment: "技术栈匹配：熟悉Python、RAG全链路（多粒度Chunking、BM25+向量混合检索、RAG效果评估）、Google ADK Agent框架、意图识别路由、Qwen3 vLLM本地部署、pgvector向量数据库，但未提及RAGFlow、Dify、LangChain、OpenCode/ClaudeCode、Cursor、next.js/Django/Tornado等JD要求的核心框架 | 项目经验相关性：香港宽频救灾AI系统涵盖Agent路由、意图判断、RAG检索与评测，与JD中智能客服平台搭建和Agent部署高度相关；格力ChatBot涉及多轮对话、意图识别、function calling，经验匹配 | 行业经验：AI应用开发一线实操经验，覆盖Agent系统、RAG、意图识别等核心领域，行业匹配度较高"},
  {index: 12, score: 28, comment: "技术栈匹配：熟悉LangChain、Coze、Multi-Agent、MCP Server、RAG、Milvus、FastAPI、Python、React，明确提到熟练使用Cursor和Claude Code进行全栈开发，与JD多个要求吻合；但未提及RAGFlow、Dify、OpenCode、next.js/Django/Tornado，AI框架覆盖面不够完整 | 项目经验相关性：Text2SQL多智能体联邦查询项目涉及LangGraph意图分发、语义检索，具备Agent协同经验；Coze Agent自动化流程经验与数字员工Agent部署相关；但缺乏知识库问答评测与调优的直接经验 | 行业经验：AI项目偏重Text2SQL和自动化处理，行业场景较单一，缺少智能客服平台建设经验"},
  {index: 13, score: 42, comment: "技术栈匹配：精通LangChain、LangGraph、RAG全链路（Milvus、BGE-Reranker、混合检索）、意图路由（Query Routing分类器）、RAGAS评测框架、MCP协议、LoRA微调、Python/FastAPI/Qwen2.5，与JD要求高度吻合；但未提及RAGFlow、Dify、OpenCode/ClaudeCode、Cursor、next.js/Django/Tornado | 项目经验相关性：基于Agent的寿险佣金诊断系统完整体现了多Agent编排（Subgraph/StateGraph）、意图路由、MCP工具服务封装、HITL人机审核，直接匹配JD中智能客服平台和Agent部署职责；RAG合规问答系统具RAGAS评测经验，与知识库回复质量评测要求高度吻合 | 行业经验：金融保险行业AI应用深度实战，企业级从0到1构建AI系统经验丰富，行业匹配度极高"},
  {index: 14, score: 18, comment: "技术栈匹配：熟悉Java（SpringBoot/SpringCloud）、Milvus向量数据库、Spring AI集成通义千问RAG、SSE流式输出，满足JD中Java语言要求；但未涉及LangChain、Dify、RAGFlow、意图识别、Agent skill搭建、OpenCode/ClaudeCode、Cursor、next.js/Django/Tornado等核心AI框架，AI技术栈覆盖面严重不足 | 项目经验相关性：PDF文档问答系统涉及RAG基础集成，但偏重Java微服务架构而非AI核心链路，缺少Agent编排、意图识别、知识库评测等关键经验，与智能客服和数字员工Agent职责差距较大 | 行业经验：主要为Java后端微服务开发经验，缺乏AI应用开发行业背景"},
  {index: 15, score: 20, comment: "技术栈匹配：熟悉Python、FastAPI、LangGraph（12节点工作流编排）、RAG全链路（Qdrant/Elasticsearch/BGE Embedding）、HuggingFace，满足Python语言要求；但未涉及RAGFlow、Dify、OpenCode/ClaudeCode、Cursor、意图识别框架、知识库评测框架、next.js/Django/Tornado，核心AI框架覆盖不足 | 项目经验相关性：AI医疗智能客服系统基于Rasa框架实现多轮对话，与智能客服场景直接相关；智能数据查询系统展示LangGraph Agent编排和RAG实践，与AI提效场景匹配；但缺乏Agent skill搭建、意图识别调优、知识库质量评测的经验 | 行业经验：实施工程师背景为主，AI项目均为个人项目级别，缺乏企业级AI应用开发和团队协作经验"},

  // Agent 4 - from completed notification
  {index: 16, score: 38, comment: "技术栈匹配：熟悉LangChain4J、Spring AI、Elasticsearch、Redis等与JD要求的LangChain系列匹配；有RAG检索链路、Agent编排、多路召回、Reranker重排等能力与RAGFlow/Dify生态对齐；掌握Java高级语言。缺少RAGFlow、Dify、next.js、Django、Tornado等具体框架经验。 | 项目经验相关性：参与多智能体平台、RAG问答系统从0到1建设，负责Agent编排、任务调度、SSE流式响应、检索优化等核心模块，与JD要求的知识库问答质量评测调优、智能体搭建高度吻合。 | 行业经验：网络安全领域知识库与Agent系统建设，虽非智能客服或数字员工直接行业，但AI应用工程化方法论可迁移；有团队协作经历。"},
  {index: 17, score: 40, comment: "技术栈匹配：直接使用RAGflow、LangChain框架，与JD要求高度契合；掌握Python和Java语言；有MCP协议开发经验（FastMCP），与OpenCode/ClaudeCode的MCP生态对接；有vLLM、Qwen3等大模型推理经验。缺少Dify、next.js、Django、Tornado等框架经验。 | 项目经验相关性：主导基于RAGflow的知识库问答系统和智能类案推荐系统，精通知识库问答质量评测与参数调优；有基于LangChain的智能问答系统升级经验，与智能客服场景直接相关；有MCP本地化平台开发经验，与Agent部署运营要求匹配。 | 行业经验：仲裁法律领域的智能文档处理与知识问答系统，虽非直接AI应用开发行业，但在RAG系统QA评测调优、Agent搭建方面积累了扎实方法论，团队协作经验丰富。"},
  {index: 18, score: 44, comment: "技术栈匹配：精通LangGraph、LangChain框架，与JD要求的LangChain系列完全匹配；掌握Python和Java语言；明确掌握Claude Code工作流，能够基于CLAUDE.md约束项目边界，设计了developer-agent等子Agent，与JD第4条OpenCode/ClaudeCode Agent skill要求高度吻合；有MCP、RAG、Skill等智能体技术经验；有Vue前端开发经验。缺少RAGFlow、Dify、next.js、Django、Tornado等具体框架经验。 | 项目经验相关性：主导智能耳机NLU模块研发，精通意图识别与槽位填充流程搭建与调优，与JD第2条完全匹配；开发智能硬件售后知识助手，涉及RAG混合检索、多Agent路由、客服问答系统，与智能客服平台搭建直接相关；有基于Agent-RAG-MCP三层架构的智能体开发经验。 | 行业经验：涉及消费电子NLU与售后客服场景，与智能客服、数字员工Agent高度相关；在校担任班长和学工助理，具备团队合作精神与沟通能力。"},
  {index: 19, score: 34, comment: "技术栈匹配：熟悉LangChain和LangGraph框架，可使用Chain调用、Retriever检索器、State/Node/Edge编排智能体工作流，与JD要求的LangChain系列匹配；掌握Python和Java语言；有FastAPI、Docker经验。缺少RAGFlow、Dify、OpenCode/ClaudeCode、Cursor、next.js、Django、Tornado等具体框架经验。 | 项目经验相关性：基于LangChain/LangGraph搭建Agent应用，参与RAG知识库、任务编排、工具调用等模块开发；有NL2SQL知识库问答系统经验；有Coze低代码平台Agent开发经验；有医疗导诊客服系统开发经验，与智能客服场景相关。 | 行业经验：涉及金融数据分析、教育、医疗、酒旅等多个行业的AI应用开发，跨行业经验丰富；项目均涉及智能客服/Agent场景，与JD职责匹配度高；团队协作完成项目落地。"},
  {index: 20, score: 36, comment: "技术栈匹配：熟悉LangChain4j和LangChainGraph框架，与JD要求的LangChain系列匹配；掌握Java语言；有MCP协议开发经验，自主开发MCP资源插件，与OpenCode/ClaudeCode的MCP生态要求高度吻合；有Milvus+Elasticsearch混合检索、VLLM大模型推理经验。缺少RAGFlow、Dify、Python、next.js、Django、Tornado等框架经验。 | 项目经验相关性：主导智能运维Agent平台开发，自主开发遵循MCP协议的硬件资源插件，实现AI与硬件系统标准化对接；基于LangChainGraph编排多轮状态流转的运维Agent；使用RAG技术构建专家知识库并做QA效果评测调优；有智能客服助手项目经验，与JD职责直接匹配。 | 行业经验：新能源充电领域IoT智能运维与客服系统，涉及智能体部署运营、AI提效场景识别，符合数字员工Agent方向；注重团队协作，有学生干部经历。"},
];

// Build lookup
const scoreMap = {};
agentResults.forEach(r => { scoreMap[r.index] = r; });

// Update candidates
d.candidates.forEach(c => {
  const r = scoreMap[c.index];
  if (r) {
    c.jobRelevanceScore = r.score;
    c.jobRelevanceComment = r.comment;
    c.totalScore = r.score;
    if (c.totalScore >= 86) c.recommendationLevel = '强烈推荐';
    else if (c.totalScore >= 72) c.recommendationLevel = '推荐';
    else if (c.totalScore >= 58) c.recommendationLevel = '可考虑';
    else c.recommendationLevel = '暂不推荐';
    c.passed = c.totalScore >= 58;
  }
});

// Sort by totalScore desc
d.candidates.sort((a, b) => b.totalScore - a.totalScore);

writeFileSync('./output/scored-candidates.json', JSON.stringify(d, null, 2));
console.log('Updated scored-candidates.json');
console.log('\n=== 总分排名 ===');
d.candidates.forEach((c, i) => {
  console.log(`${i+1}. ${c.basicInfo.name} | 总分:${c.totalScore} (AI相关性评分) | ${c.recommendationLevel}`);
});

// Count
const passCount = d.candidates.filter(c => c.passed).length;
console.log(`\n通过: ${passCount}/${d.candidates.length} 人`);
