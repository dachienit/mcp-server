import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { ADTClient } from "abap-adt-api";

export class ObjectHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'objectStructure',
                description: 'Get object structure details',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectUrl: {
                            type: 'string',
                            description: 'URL of the object'
                        },
                        version: {
                            type: 'string',
                            description: 'Version of the object',
                            optional: true
                        }
                    },
                    required: ['objectUrl']
                }
            },
            {
                name: 'searchObject',
                description: 'Search for objects',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Search query string'
                        },
                        objType: {
                            type: 'string',
                            description: 'Object type filter',
                            optional: true
                        },
                        max: {
                            type: 'number',
                            description: 'Maximum number of results',
                            optional: true
                        }
                    },
                    required: ['query']
                }
            },
            {
                name: 'searchPackage',
                description: 'Search exactly for a package and retrieve all objects contained within it',
                inputSchema: {
                    type: 'object',
                    properties: {
                        packageName: {
                            type: 'string',
                            description: 'Exact package name (e.g., ZDEMO_PKG)'
                        }
                    },
                    required: ['packageName']
                }
            },
            {
                name: 'findObjectPath',
                description: 'Find path for an object',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectUrl: {
                            type: 'string',
                            description: 'URL of the object to find path for'
                        }
                    },
                    required: ['objectUrl']
                }
            },
            {
                name: 'objectTypes',
                description: 'Retrieves object types.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'reentranceTicket',
                description: 'Retrieves a reentrance ticket.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'objectStructure':
                return this.handleObjectStructure(args);
            case 'findObjectPath':
                return this.handleFindObjectPath(args);
            case 'searchObject':
                return this.handleSearchObject(args);
            case 'searchPackage':
                return this.handleSearchPackage(args);
            case 'objectTypes':
                return this.handleObjectTypes(args);
            case 'reentranceTicket':
                return this.handleReentranceTicket(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown object tool: ${toolName}`);
        }
    }

    async handleObjectStructure(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const structure = await this.adtclient.objectStructure(args.objectUrl, args.version);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            structure,
                            message: 'Object structure retrieved successfully'
                        }, null, 2)
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            const errorMessage = error.message || 'Unknown error';
            const detailedError = error.response?.data?.message || errorMessage;
            throw new McpError(
                ErrorCode.InternalError,
                `Failed to get object structure: ${detailedError}`
            );
        }
    }

    async handleFindObjectPath(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const path = await this.adtclient.findObjectPath(args.objectUrl);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            path,
                            message: 'Object path found successfully'
                        }, null, 2)
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            const errorMessage = error.message || 'Unknown error';
            const detailedError = error.response?.data?.message || errorMessage;
            throw new McpError(
                ErrorCode.InternalError,
                `Failed to find object path: ${detailedError}`
            );
        }
    }

    async handleSearchObject(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const results = await this.adtclient.searchObject(
                args.query,
                args.objType,
                args.max
            );
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            results,
                            message: 'Object search completed successfully'
                        }, null, 2)
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            const errorMessage = error.message || 'Unknown error';
            const detailedError = error.response?.data?.message || errorMessage;
            throw new McpError(
                ErrorCode.InternalError,
                `Failed to search objects: ${detailedError}`
            );
        }
    }

    async handleSearchPackage(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const pkgName = args.packageName.toUpperCase();
            const maxResults = args.maxResults || 100;
            
            // 1. Verify the package exists first via searchObject
            const pkgs = await this.adtclient.searchObject(pkgName, 'DEVC/K', 1);
            if (!pkgs || pkgs.length === 0 || pkgs[0]['adtcore:name'] !== pkgName) {
                this.trackRequest(startTime, true);
                return {
                    content: [
                        { type: 'text', text: JSON.stringify({ status: 'success', results: [], message: `Package ${pkgName} not found or no exact match.` }, null, 2) }
                    ]
                };
            }

            const pkg = pkgs[0];
            console.log(`[ObjectHandlers] Found exact package ${pkgName}, fetching contents...`);

            // 2. Use the identical approach as the CAP project:
            //    quickSearch with query=* and packageName=PACKAGE_NAME
            //    This is the proven ADT endpoint for listing all objects in a package.
            const ADT_BASE = '/sap/bc/adt';
            const contentsPath = `${ADT_BASE}/repository/informationsystem/search?operation=quickSearch&query=*&packageName=${encodeURIComponent(pkgName)}&maxResults=${maxResults}`;
            
            const response = await (this.adtclient as any).h.request(contentsPath, {
                headers: { 'Accept': 'application/vnd.sap.adt.repository.informationsystem.search.result.v1+xml, application/xml' }
            });

            const xml = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
            const objects: any[] = [];
            
            // Push the package itself first
            objects.push({ 
                name: pkg['adtcore:name'], 
                type: 'DEVC/K', 
                description: pkg['adtcore:description'] || '', 
                packageName: pkg['adtcore:packageName'] || '' 
            });

            // Parse the XML to extract all child objects (mirroring the CAP project regex)
            const refPattern = /<(?:adtcore:objectReference)[^>]*?>/gm;
            const namePattern = /adtcore:name="([^"]+)"/;
            const typePattern = /adtcore:type="([^"]+)"/;
            const descPattern = /adtcore:description="([^"]*)"/;
            const uriPattern = /adtcore:uri="([^"]+)"/;
            const pkgPattern = /adtcore:packageName="([^"]*)"/;

            let match;
            while ((match = refPattern.exec(xml)) !== null) {
                const tag = match[0];
                const cName = (namePattern.exec(tag) || [])[1];
                const cType = (typePattern.exec(tag) || [])[1];
                if (cName && cType) {
                    objects.push({
                        name: cName,
                        type: cType,
                        description: (descPattern.exec(tag) || [])[1] || '',
                        packageName: (pkgPattern.exec(tag) || [])[1] || pkgName,
                        url: (uriPattern.exec(tag) || [])[1] || ''
                    });
                }
            }

            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            results: objects,
                            message: `Package ${pkgName} contains ${objects.length - 1} objects`
                        }, null, 2)
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            const errorMessage = error.message || 'Unknown error';
            const detailedError = error.response?.data?.message || errorMessage;
            throw new McpError(
                ErrorCode.InternalError,
                `Failed to search package: ${detailedError}`
            );
        }
    }


    async handleObjectTypes(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const types = await this.adtclient.objectTypes();
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            types,
                            message: 'Object types retrieved successfully'
                        }, null, 2)
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            const errorMessage = error.message || 'Unknown error';
            const detailedError = error.response?.data?.message || errorMessage;
            throw new McpError(
                ErrorCode.InternalError,
                `Failed to get object types: ${detailedError}`
            );
        }
    }

    async handleReentranceTicket(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const ticket = await this.adtclient.reentranceTicket();
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            ticket,
                            message: 'Reentrance ticket retrieved successfully'
                        }, null, 2)
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            const errorMessage = error.message || 'Unknown error';
            const detailedError = error.response?.data?.message || errorMessage;
            throw new McpError(
                ErrorCode.InternalError,
                `Failed to get reentrance ticket: ${detailedError}`
            );
        }
    }
}
