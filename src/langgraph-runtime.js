export async function createLangGraphRuntime() {
  try {
    const langgraph = await import('@langchain/langgraph');
    return {
      available: true,
      source: '@langchain/langgraph',
      langgraph,
    };
  } catch (err) {
    return {
      available: false,
      source: '@langchain/langgraph',
      error: err instanceof Error ? err.message : 'LangGraph is not installed',
    };
  }
}
