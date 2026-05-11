declare module "google-trends-api" {
  const googleTrends: {
    interestOverTime(opts: {
      keyword: string;
      startTime?: Date;
      geo?: string;
    }): Promise<string>;
  };
  export default googleTrends;
}
