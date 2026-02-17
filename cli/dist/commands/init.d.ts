export declare function init(): Promise<void>;
/** Generate AGENTS.md — canonical AI instructions for all tools */
export declare function generateAgentsMd(clientName: string): string;
/** Generate CLAUDE.md — full instructions for Claude Code (not a pointer) */
export declare function generateClaudeMdPointer(): string;
/** Generate .github/copilot-instructions.md — thin pointer to AGENTS.md for GitHub Copilot */
export declare function generateCopilotInstructions(): string;
/** Generate README.md for client systems */
export declare function generateReadme(clientName: string): string;
