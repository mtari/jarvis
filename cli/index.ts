import { dispatch } from "./dispatch.ts";

const code = await dispatch(process.argv.slice(2));
process.exit(code);
