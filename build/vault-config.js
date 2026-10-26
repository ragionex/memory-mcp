import fs from "node:fs";
import path from "node:path";
import { parse, printParseErrorCode } from "jsonc-parser";
import { z } from "zod";
import { isMissing } from "./durable-fs.js";
import { ApiError, vaultId } from "./memory-contract.js";
const PROJECT_FILE = "RAGIONEX_MEMORY.jsonc";
const API_KEY_FORMAT = /^[\x21-\x7e]+$/;
const configSchema = z.object({
    vault_id: vaultId,
    api_key: z.string().min(1).optional(),
}).strict();
export function configError(reason, filePath, details = {}) {
    const file = filePath ?? PROJECT_FILE;
    const field = Array.isArray(details.field) && details.field.length ? details.field.join(".") : "the top level";
    const problem = {
        syntax: `${file} is not valid JSONC (${details.problem} at line ${details.line}, column ${details.column})`,
        shape: `${file} must hold a "vault_id" and may hold an "api_key"; the problem is at ${field}`,
        read_failed: `${file} could not be read (${details.code})`,
        invalid_api_key: details.key_source === "project_file"
            ? `The api_key in ${file} is not a valid key`
            : "RAGIONEX_MEMORY_API_KEY is not a valid key",
        absolute_folder_required: "The agent reported a project folder that cannot be used",
        invalid_project_folder: "The agent reported a project folder that cannot be used",
        ambiguous_project_folder: "The agent reported more than one project folder, so no project file can be chosen",
    }[reason] ?? reason;
    return new ApiError(`[config_error: ${reason}] ${problem}. This request was not carried out. Tell the user. Change the project file only if the user asks.`, 400, "config_error");
}
export function parseConfig(text, filePath = null) {
    const errors = [];
    const value = parse(text, errors, { allowTrailingComma: true });
    if (errors.length) {
        const error = errors[0];
        const lines = text.slice(0, error.offset).split(/\r\n|\r|\n/);
        throw configError("syntax", filePath, {
            problem: printParseErrorCode(error.error),
            line: lines.length,
            column: lines[lines.length - 1].length + 1,
        });
    }
    const parsed = configSchema.safeParse(value);
    if (!parsed.success) {
        throw configError("shape", filePath, { field: parsed.error.issues[0].path });
    }
    return parsed.data;
}
export function readConfig(workingFolder, environmentKey) {
    const filePath = workingFolder === undefined ? null : path.join(workingFolder, PROJECT_FILE);
    let parsed;
    if (filePath !== null) {
        let text;
        try {
            text = fs.readFileSync(filePath, "utf-8");
        }
        catch (error) {
            if (!isMissing(error)) {
                throw configError("read_failed", filePath, { code: error.code ?? "read_failed" });
            }
        }
        if (text !== undefined)
            parsed = parseConfig(text, filePath);
    }
    const key = parsed?.api_key === undefined ? environmentKey : parsed.api_key;
    if (key !== undefined && !API_KEY_FORMAT.test(key)) {
        throw configError("invalid_api_key", filePath, {
            key_source: parsed?.api_key === undefined ? "environment" : "project_file",
        });
    }
    return {
        key,
        vaultId: parsed?.vault_id,
        filePath,
        details: {
            key_source: parsed?.api_key === undefined ? "environment" : "project_file",
            vault_source: parsed === undefined ? "account_default" : "project_file",
            working_folder: workingFolder ?? null,
            config_file: filePath,
        },
    };
}
