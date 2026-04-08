export const createMockQueue = () => ({
  add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
  getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0 }),
});
