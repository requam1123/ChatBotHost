export async function createLangGraphRuntime() {
  try {
    const langgraph = await import('@langchain/langgraph');
    return {
      available: true,
      source: '@langchain/langgraph',
      langgraph,
      runPlannerWorkerGraph: (options) => runPlannerWorkerGraph(langgraph, options),
    };
  } catch (err) {
    return {
      available: false,
      source: '@langchain/langgraph',
      error: err instanceof Error ? err.message : 'LangGraph is not installed',
    };
  }
}

async function runPlannerWorkerGraph(langgraph, options) {
  const { Annotation, StateGraph, START, END } = langgraph;
  const GraphState = Annotation.Root({
    task: Annotation(),
    context: Annotation(),
    plannerAgent: Annotation(),
    workerAgent: Annotation(),
    event: Annotation(),
    workerTask: Annotation(),
    workerOutput: Annotation(),
    finalOutput: Annotation(),
    steps: Annotation({
      reducer: (left = [], right = []) => left.concat(right),
      default: () => [],
    }),
  });

  const graph = new StateGraph(GraphState)
    .addNode('planner', async (state) => {
      const workerTask = buildWorkerTask(state.task, state.context, state.workerAgent);
      return {
        workerTask,
        steps: [{
          node: 'planner',
          output: workerTask,
          time: Date.now(),
        }],
      };
    })
    .addNode('worker', async (state) => {
      const result = await options.generateReply(state.workerAgent, {
        ...state.event,
        sendID: state.plannerAgent.imAgentUserID,
        recvID: state.workerAgent.imAgentUserID,
        content: state.workerTask,
        serverMsgID: '',
      });
      return {
        workerOutput: result.content,
        steps: [{
          node: 'worker',
          agentID: state.workerAgent.userAgentID,
          output: result.content,
          provider: result.provider,
          endpoint: result.endpoint,
          model: result.model,
          time: Date.now(),
        }],
      };
    })
    .addNode('summary', async (state) => {
      const result = await options.generateReply(state.plannerAgent, {
        ...state.event,
        content: buildSummaryTask(state.task, state.workerOutput),
      });
      return {
        finalOutput: result.content,
        steps: [{
          node: 'summary',
          agentID: state.plannerAgent.userAgentID,
          output: result.content,
          provider: result.provider,
          endpoint: result.endpoint,
          model: result.model,
          time: Date.now(),
        }],
      };
    })
    .addEdge(START, 'planner')
    .addEdge('planner', 'worker')
    .addEdge('worker', 'summary')
    .addEdge('summary', END)
    .compile();

  return graph.invoke({
    task: options.task,
    context: options.context || '',
    plannerAgent: withoutTools(options.plannerAgent),
    workerAgent: withoutTools(options.workerAgent),
    event: options.event,
    workerTask: '',
    workerOutput: '',
    finalOutput: '',
    steps: [],
  });
}

function buildWorkerTask(task, context, workerAgent) {
  return `You are acting as ${workerAgent.nickname}.

Task:
${task}

Context:
${context || 'No extra context provided.'}

Return a concise specialist result for the planner.`;
}

function buildSummaryTask(task, workerOutput) {
  return `A specialist worker returned the following result.

Original user task:
${task}

Worker result:
${workerOutput}

Synthesize a final answer for the user. Be concise and actionable.`;
}

function withoutTools(agent) {
  return {
    ...agent,
    enabledToolIDs: [],
  };
}
