import { ADTClient, session_types } from 'abap-adt-api';
import { AbapAdtServer } from './index.js';
import { createBtpAdtClient } from './lib/btpDestination.js';

/**
 * Factory to create an AbapAdtServer instance configured for BTP (with Destination routing) 
 * or local mode (with direct credentials from `.env`).
 */
export async function createMcpServer(userJwt?: string, destinationName?: string): Promise<AbapAdtServer> {
  let adtClient: ADTClient;

  // Check if we are running on BTP (VCAP_SERVICES is present) 
  // or if user forced it by providing destination variables
  if (process.env.VCAP_SERVICES || userJwt) {
    const destName = destinationName || process.env.SAP_DESTINATION_NAME || 'SAP_ONPREM';
    if (!userJwt) {
      throw new Error("Missing user JWT for BTP Destination PrincipalPropagation.");
    }
    
    console.log(`[MCP Server Factory] Initializing ADTClient via BTP Destination: ${destName}`);
    adtClient = await createBtpAdtClient(userJwt, destName);
  } else {
    // Local .env fallback mode
    const missingVars = ['SAP_URL', 'SAP_USER', 'SAP_PASSWORD'].filter(v => !process.env[v]);
    if (missingVars.length > 0) {
      throw new Error(`Missing required local environment variables: ${missingVars.join(', ')}`);
    }

    console.log(`[MCP Server Factory] Initializing ADTClient via Local Credentials to: ${process.env.SAP_URL}`);
    adtClient = new ADTClient(
      process.env.SAP_URL as string,
      process.env.SAP_USER as string,
      process.env.SAP_PASSWORD as string,
      process.env.SAP_CLIENT as string,
      process.env.SAP_LANGUAGE as string
    );
    adtClient.stateful = session_types.stateful;
  }

  return new AbapAdtServer(adtClient);
}
