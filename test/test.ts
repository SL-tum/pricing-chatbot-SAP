function extractJsonFromReturnValue(returnValue: any): any | null {
    if (typeof returnValue === 'string') {
      const jsonPattern = /\{[\s\S]*?\}/;
      const match = returnValue.match(jsonPattern);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch (e) {
          console.error("Failed to parse JSON:", e);
        }
      }
    }
    return null;
  }
  
  // 测试用例
  console.log(extractJsonFromReturnValue('{ "key": "value" }')); 
  console.log(extractJsonFromReturnValue('Some text { "key": "value" } more text'));
  console.log(extractJsonFromReturnValue('{ invalid json }')); 
  console.log(extractJsonFromReturnValue('No JSON here'));
  console.log(extractJsonFromReturnValue(null)); 
  console.log(extractJsonFromReturnValue(123)); 
  console.log(extractJsonFromReturnValue('[1, 2, 3]')); 
  