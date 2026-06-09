export async function createLangGraphSupervisorRuntime() {
  try {
    const langgraph = await import('@langchain/langgraph');
    return {
      available: true,
      source: '@langchain/langgraph',
      langgraph,
      runVisibleSupervisorGraph: (options) => runVisibleSupervisorGraph(langgraph, options),
    };
  } catch (err) {
    return {
      available: false,
      source: '@langchain/langgraph',
      error: err instanceof Error ? err.message : 'LangGraph supervisor runtime is not available',
    };
  }
}

async function runVisibleSupervisorGraph(langgraph, options) {
  const { Annotation, StateGraph, START, END } = langgraph;
  const GraphState = Annotation.Root({
    runID: Annotation(),
    task: Annotation(),
    plannerAgent: Annotation(),
    workerAgent: Annotation(),
    reviewerAgent: Annotation(),
    event: Annotation(),
    cleanTask: Annotation(),
    workspaceContext: Annotation(),
    selectionReason: Annotation(),
    workerValidation: Annotation(),
    plannerAck: Annotation(),
    plannerDelegate: Annotation(),
    coderAck: Annotation(),
    workerTask: Annotation(),
    workerOutput: Annotation(),
    reviewTask: Annotation(),
    reviewerOutput: Annotation(),
    finalOutput: Annotation(),
    responseServerMsgID: Annotation(),
    graphSteps: Annotation({
      reducer: (left = [], right = []) => left.concat(right),
      default: () => [],
    }),
    toolCalls: Annotation({
      reducer: (left = [], right = []) => left.concat(right),
      default: () => [],
    }),
  });

  const graph = new StateGraph(GraphState)
    .addNode('planner_ack', async (state) => options.nodes.plannerAck(state))
    .addNode('planner_delegate', async (state) => options.nodes.plannerDelegate(state))
    .addNode('worker', async (state) => options.nodes.worker(state))
    .addNode('reviewer', async (state) => {
      if (!state.reviewerAgent || state.workerValidation?.ok === false) return { graphSteps: [] };
      return options.nodes.reviewer(state);
    })
    .addNode('summary', async (state) => options.nodes.summary(state))
    .addEdge(START, 'planner_ack')
    .addEdge('planner_ack', 'planner_delegate')
    .addEdge('planner_delegate', 'worker')
    .addEdge('worker', 'reviewer')
    .addEdge('reviewer', 'summary')
    .addEdge('summary', END)
    .compile();

  return graph.invoke({
    runID: options.runID,
    task: options.task,
    cleanTask: options.cleanTask,
    workspaceContext: options.workspaceContext || {},
    selectionReason: options.selectionReason || '',
    plannerAgent: options.plannerAgent,
    workerAgent: options.workerAgent,
    reviewerAgent: options.reviewerAgent || null,
    event: options.event,
    plannerAck: '',
    plannerDelegate: '',
    coderAck: '',
    workerTask: '',
    workerOutput: '',
    workerValidation: null,
    reviewTask: '',
    reviewerOutput: '',
    finalOutput: '',
    responseServerMsgID: '',
    graphSteps: [],
    toolCalls: [],
  });
}
