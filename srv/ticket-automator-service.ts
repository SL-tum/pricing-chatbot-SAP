import cds from "@sap/cds";
import { Buffer } from "buffer";

interface Stored_info {
  service: string | null;
  service_plan: string | null;
  commercial_model: string | null;
};

const systemPrompt = 
`Your task is to determine whether the user query and context mention any of the following three types of information: Service, Service Plan, and Commercial Model.

You must return a response in pure JSON format. The structure and keys of the JSON must not be modified, and you can only change the values under the three specified keys.

Response Format:
If the query mentions a Service, Service Plan, or Commercial Model, return the following JSON format, replacing values accordingly:

{
   "service": "mentioned Service",
   "service_plan": "mentioned Service Plan",
   "commercial_model": "mentioned Commercial Model"
}
If the query does not mention one or more of these three elements, set the corresponding key's value to null.

Examples:
Example 1:
User input:
"Can you give me the price information about SAP HANA Analysis Cloud? My service plan is standard."

Response:
{
   "service": "SAP HANA Analysis Cloud",
   "service_plan": "Standard",
   "commercial_model": null
}

Example 2:
User input:
"Can I have all the price info about SAP HANA Analysis Cloud?"

Response:
{
   "service": "SAP HANA Analysis Cloud",
   "service_plan": null,
   "commercial_model": null
}

Example 3:
User input:
"Hello, how are you!"

Response:
{
   "service": null,
   "service_plan": null,
   "commercial_model": null
}
Note: The assistant must not return any additional text outside of the JSON response.
`;

const hrRequestPrompt = 
`
You are a chatbot designed to assist users with questions related to prices for SAP services. Your goal is to provide accurate pricing information based on the user’s inquiry, taking into account the specific SAP service, service plan, commercial model, and region. You will be provided with contextual information that includes the user's questions, previous responses, and additional knowledge related to the SAP services, plans, and pricing.


Key guidelines for your responses:

Default region: Set the default region as EU. If the user mentions another region, then change to it. Otherwise provide answers based on region = EU, and announce that the infor is based on EU.
Contextual Awareness: You should reference both the user’s current question and the context of your previous responses when formulating an answer.
Service & Service Plan Matching: Make sure your answer aligns with the specific SAP service and service plan the user is asking about. Prices vary depending on the service, service plan, region, and commercial model. But provide what you know only base on the service, service plan, region, and commercial model must appear in the response, but don't ask again.
Accuracy: Do not make up any pricing information. Only reference the provided pricing details.
Price Formatting: When providing pricing details, present them in a clear format such as a table, and ensure the price is followed by the € symbol to indicate that the price is in euros.
Knowledge Assistance: If additional knowledge or information about SAP services and pricing is provided to you, use it to supplement your answer.
Always ensure that the information you provide is accurate and relevant to the user's specific inquiry about SAP services and pricing.
If the information contains phrases such as:"Unknown Price, Please check again." or "The service under this service plan is free." Then, explicitly inform the user that the service is free.
If the provided information don't contain the combination which mentioned by user, you should declear you don't know the combination and suggest him to check the combination of provided info. And you must provide all you known from provided info including Technical Features, commercial model pricing and so on as a table.

Example of Answer Format:

SAP Build Process Automation
Service Plan: Free
Technical Features:
Feature|Quantity|Description|MoreInfo(link)
-------|--------|-----------|--------------
Job Quota Limit|150|A job is a single event triggered by the execution of a deployed project. With the Free Plan, you can trigger up to 600 jobs.|Quotas, Restrictions, and Limits
Commercial Model: Free (Non-Billable)
for the following regions: CLOUD FOUNDRY, AWS, US East (VA);CLOUD FOUNDRY, Microsoft Azure, Singapore;CLOUD FOUNDRY, Microsoft Azure, Brazil South;CLOUD FOUNDRY, Google Cloud, Australia Southeast (Sydney).
Unknown Price, Please check again; Or the service under this service plan is free.

Commercial Model: Cloud Credits,btpea,PPAYG (Billable)
for the following regions: CLOUD FOUNDRY, Google Cloud, KSA (Dammam – KSA Regulated Customers);CLOUD FOUNDRY, Google Cloud, Israel (Tel Aviv);CLOUD FOUNDRY, Microsoft Azure, US West (WA);CLOUD FOUNDRY, Microsoft Azure, Europe (Netherlands);CLOUD FOUNDRY, AWS, Canada (Montreal);CLOUD FOUNDRY, Google Cloud, US Central (IA);CLOUD FOUNDRY, Microsoft Azure, Switzerland (EU Access);CLOUD FOUNDRY, Google Cloud, Europe (Frankfurt);CLOUD FOUNDRY, AWS, Brazil (São Paulo);CLOUD FOUNDRY, AWS, Singapore;CLOUD FOUNDRY, Microsoft Azure, Australia (Sydney);CLOUD FOUNDRY, Microsoft Azure, Japan (Tokyo);CLOUD FOUNDRY, Microsoft Azure, US East (VA);CLOUD FOUNDRY, Microsoft Azure, Singapore;CLOUD FOUNDRY, Google Cloud, India (Mumbai);CLOUD FOUNDRY, AWS, Australia (Sydney);CLOUD FOUNDRY, AWS, Europe (Frankfurt);CLOUD FOUNDRY, AWS, US East (VA);CLOUD FOUNDRY, AWS, Japan (Tokyo);CLOUD FOUNDRY, Google Cloud, Australia Southeast (Sydney);CLOUD FOUNDRY, AWS, Europe (Frankfurt) EU Access;CLOUD FOUNDRY, AWS, South Korea (Seoul);CLOUD FOUNDRY, Microsoft Azure, Brazil South.
Prices:
Metric|Billing Block Size|Unit Price per Month
------|------------------|--------------------
Active Users|1|0.00


`
;

const classifyPrompt = 
`
You are a binary classifier to judge if the user is asking about pricing information. You must also consider about the context, not only the recent question.

You must return a response only with one of thess two values: true, false.

If the user's question is about pricing of SAP services, then return true. For example:
Example 1:
{
  "role": "user",
  "content": "Can I have all the price info about SAP HANA Analysis Cloud?"
        }

Response:
true
Example 2:

{
  "role": "user",
  "content": "Can I have all the price info about SAP HANA Analysis Cloud?"
        },
{
  "role": "assistant",
  "content":  "service": "SAP HANA Analysis Cloud",
              "service_plan": null,
              "commercial_model": null
        },
{
  "role": "user",
  "content": "My service plan is Production, commercial model is btpea."
        }

Response:
true

Otherwises, return false. For example:
Example 1
{
  "role": "user",
  "content": "Hi, how are you?"
        },

Response:
false

`;


;

export class TicketAutomatorService extends cds.ApplicationService {
  async init(): Promise<void> {
    const vectorPlugin = await cds.connect.to("cap-llm-plugin");
    const stored_info: Stored_info = {
      service : null,
      service_plan : null,
      commercial_model : null,
    };
    let context: { role: string, content: string }[] = [];

    this.on("sendQuestion", async (req: any) => {
      const { question } = req.data;
      
      const model_name = "gpt-35-turbo";
      
      //build the payload for updating stored_info
      const payload_prequery = await (vectorPlugin as any).buildChatPayload(model_name, question, systemPrompt, context);

      //ask LLM for updating stored_info
      const determinationResponse = await (vectorPlugin as any).getChatCompletion(payload_prequery);
      //console.log(determinationResponse);
      const determinationJson = extractJsonFromReturnValue(determinationResponse.content);
      //console.log(determinationJson);

      //update stored_info
      if (determinationJson){
        const service = determinationJson?.service;
        const service_plan = determinationJson?.service_plan;
        const commercial_model = determinationJson?.commercial_model;
        if ( !stored_info.service && service){
          stored_info.service = service;
        };
        if ( !stored_info.service_plan && service_plan){
          stored_info.service_plan = service_plan;
        };
        if ( !stored_info.commercial_model && commercial_model){
          stored_info.commercial_model = commercial_model;
        };
      };
      //ask if it is about pricing information
      const payload_classify = await (vectorPlugin as any).buildChatPayload(model_name, question, classifyPrompt, context);
      const classificationResponse = await (vectorPlugin as any).getChatCompletion(payload_classify);
      console.log(classificationResponse);
      let classify_result = false;
      try {
        classify_result = JSON.parse(classificationResponse.content);
    } catch (error) {
        classify_result = true;
    }
      // Similarity Search
      if (stored_info.service && stored_info.service_plan && classify_result) {
        const algoName = 'COSINE_SIMILARITY';
        const topK = 7;
        const search_content = stored_info.service + stored_info.service_plan;
        const new_search_content = search_content.replace(/ /g, "_");
        const similarContent = await similaritySearch(
          vectorPlugin,
          new_search_content,
          algoName, 
          topK,);
        console.log(similarContent);
        console.log('Similarity Search finished');

        let messagePayload_searched = [
          {
            "role": "system",
            "content": ` ${hrRequestPrompt} `
          }
        ];
        const userQuestion_searched = [
          {
            "role": "user",
            "content": `${question} \n ${similarContent.similarContent}`
          }
        ];
        if (typeof context !== 'undefined' && context !== null && context.length > 0) {
          messagePayload_searched.push(...context);
        };
        messagePayload_searched.push(...userQuestion_searched);
        let payload_searched = {
          "messages": messagePayload_searched
        };
        
        const chatCompletionResp = await (vectorPlugin as any).getChatCompletion(payload_searched);


        console.log(messagePayload_searched);
        const ragResp = {
          "completion": chatCompletionResp,
        };
        //Update Context
        context.push(
          {
            "role": "user",
            "content": `${question}`
          }
        );
        
        context.push(
          {
            "role": "assistant",
            "content": `${similarContent}`
          }
        );
        context.push(
          {
            "role": "assistant",
            "content": `${chatCompletionResp}`
          }
        );
        const len_of_Context = await getTotalStringLength(context);

        if (len_of_Context >= 1000){
          context.splice(0, 3);
        }
        stored_info.service = null;
        stored_info.service_plan = null;
        stored_info.commercial_model = null;

        return ragResp.completion.content;

        };

      let messagePayload_further = [
        {
          "role": "system",
          "content": ` ${hrRequestPrompt} `
        }
      ];
      const userQuestion_further= [
        {
          "role": "user",
          "content": `${question}`
        }
      ];

      const context_further = JSON.stringify(stored_info);
      if (typeof context !== 'undefined' && context !== null && context.length > 0) {
        messagePayload_further.push(...context);
      }
      messagePayload_further.push({
        "role": "assistant",
        "content": `${context_further}`
      });
      messagePayload_further.push(...userQuestion_further);
    
      let payload_further = {
        "messages": messagePayload_further
      };
      
      const chatCompletionResp_further = await (vectorPlugin as any).getChatCompletion(payload_further);
      console.log(chatCompletionResp_further.content);
      const ragResp_further = {
        "completion": chatCompletionResp_further,
      };
      context.push(
        {
          "role": "user",
          "content": `${question}`
        }
      );
      context.push(
        {
          "role": "assistant",
          "content": `${chatCompletionResp_further}`
        }
      );
      return ragResp_further.completion.content;

      }
    );
  }
}


let getTotalStringLength = async( list: any[]
): Promise<number> => {
  let totalLength = 0;

  function calculateLength(obj: any) {
      if (typeof obj === "string") {
          totalLength += obj.length;
      } else if (Array.isArray(obj)) {
          obj.forEach(item => calculateLength(item));
      } else if (typeof obj === "object" && obj !== null) {
          Object.values(obj).forEach(value => calculateLength(value));
      }
  }

  calculateLength(list);
  return totalLength;
}
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


let similaritySearch = async(
  vectorPlugin: cds.Service,
  input: string,
  algoName: string, 
  topK: number,
) => {

  try{
    const query = await (vectorPlugin as any).getEmbedding(input);
    
    const payload = {
      queryEmbedding: await array2VectorBuffer(query),
      algoName: algoName,
      topK: topK
    };
    const similarContent = await sendQuestion2cap(payload);
    console.log(similarContent);
    return typeof similarContent === "string" ? JSON.parse(similarContent) : similarContent;
  }
  catch (error: any) {
    console.error('Failed to do similarity search:', error.response?.data || error.message);
    throw new Error('Could not do similarity search.');
  }
  
};

let sendQuestion2cap = async(
  payload: any,
) => {
  try{
    
    const myService = await cds.connect.to("MyService");
    return await (myService as any).send("similaritySearch", payload);
  }
catch (error) {
  console.log('Error during execution:', error);
  throw error;
}
};

let array2VectorBuffer = async(data: any) => {
  const sizeFloat = 4;
  const sizeDimensions = 4;
  const bufferSize = data.length * sizeFloat + sizeDimensions;

  const buffer = Buffer.allocUnsafe(bufferSize);
  buffer.writeUInt32LE(data.length, 0);
  data.forEach((value: any, index: any) => {
    buffer.writeFloatLE(value, index * sizeFloat + sizeDimensions);
  });
  return buffer;
};
