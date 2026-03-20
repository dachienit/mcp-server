import { ADTClient, session_types, HttpClient } from 'abap-adt-api';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { getDestination, Destination } from '@sap-cloud-sdk/connectivity';
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

// Custom HttpClient that routes ADT requests through BTP Destination via SAP Cloud SDK
class BtpDestinationHttpClient implements HttpClient {
  constructor(private destination: Destination, private userJwt: string) {}

  async request(options: any): Promise<any> {
    try {
      const response = await executeHttpRequest(this.destination as any, {
        method: options.method || 'GET',
        url: options.url,
        data: options.body,
        headers: options.headers,
        params: options.qs,
        // SAP Cloud SDK handles proxying, SSL, and PrincipalPropagation via the JWT
      }, {
        fetchCsrfToken: false // ADT client manually manages CSRF
      });

      return {
        body: typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
        status: response.status,
        statusText: response.statusText,
        headers: response.headers as any,
        request: response.config
      };
    } catch (error: any) {
      const errMsg = error.response ? `${error.response.status}: ${JSON.stringify(error.response.data)}` : error.message;
      throw new Error(`BTP HTTP Request Failed: ${errMsg}`);
    }
  }
}

export async function createBtpAdtClient(userJwt: string, destinationName: string): Promise<ADTClient> {
  try {
    // Retrieve destination using the user's JWT
    const destination = await getDestination({
      destinationName,
      jwt: userJwt,
      useCache: true
    });

    if (!destination) {
      throw new Error(`Destination '${destinationName}' not found.`);
    }

    const customHttpClient = new BtpDestinationHttpClient(destination, userJwt);

    // Initialize ADTClient passing our custom HTTP Client
    const client = new ADTClient(
      customHttpClient, 
      '', // username
      '', // password
      process.env.SAP_CLIENT || '', 
      process.env.SAP_LANGUAGE || 'EN'
    );
    
    client.stateful = session_types.stateful;

    return client;
  } catch (err: any) {
    throw new McpError(ErrorCode.InternalError, `Failed to initialize BTP ADT Client: ${err.message}`);
  }
}
