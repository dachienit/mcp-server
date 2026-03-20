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

    const url = destination?.url;
    if (!url) {
      throw new Error(`Destination '${destinationName}' is missing a valid URL.`);
    }

    // Initialize ADTClient with the URL from destination.
    // We pass dummy username/password to satisfy the constructor's validation,
    // as our customHttpClient will handle the actual authentication via JWT.
    const client = new ADTClient(
      url,
      'BTP_USER',
      'BTP_PASSWORD',
      process.env.SAP_CLIENT || '',
      process.env.SAP_LANGUAGE || 'EN'
    );

    const customHttpClient = new BtpDestinationHttpClient(destination, userJwt);
    
    // Replace the internal HttpClient with our BTP-aware implementation
    // @ts-ignore - we are injecting our custom client
    client.httpClient = customHttpClient;

    client.stateful = session_types.stateful;

    return client;
  } catch (err: any) {
    throw new McpError(ErrorCode.InternalError, `Failed to initialize BTP ADT Client: ${err.message}`);
  }
}
