/** A GitHub pull request URL (shared by server and client components). */
export const isPullRequest = (url: string | undefined): url is string => !!url && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.test(url);
