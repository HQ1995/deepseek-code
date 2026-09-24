/** The runtime's plugin resolution follows the dsh CLI's dependency graph,
 * which does not reach some packages the dscode runtime ships (the browser-use
 * and Playwright MCP packages, and the SSH providers).
 * Load them from the same installation, beside a package that graph reaches,
 * so there is one SDK copy and nothing is installed from the network. */
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const reached = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-mcp-client/package.json')
const marker = sep + 'node_modules' + sep
const modules = reached.slice(0, reached.lastIndexOf(marker) + marker.length - 1)

/** Resolve inside the installation's node_modules, never the plugin's own tree. */
const runtimeRequire = createRequire(join(modules, '.dscode-browser.cjs'))
export const importRuntime = specifier => import(pathToFileURL(runtimeRequire.resolve(specifier)).href)
/** The Playwright MCP command line, from the same installation. */
export const playwrightMcpCli = () => join(dirname(runtimeRequire.resolve('@playwright/mcp/package.json')), 'cli.js')
