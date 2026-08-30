import { createPushRegistrationAttempt } from './pushRegistrationAttempt';

it('coalesces launch and foreground registration and retries after a failed result', async () => {
  let resolve!: (result: string) => void;
  const register = jest
    .fn<Promise<string>, []>()
    .mockImplementationOnce(() => new Promise((done) => (resolve = done)))
    .mockResolvedValueOnce('registered');
  const attempt = createPushRegistrationAttempt(register);

  const launch = attempt();
  const foreground = attempt();
  expect(register).toHaveBeenCalledTimes(1);
  resolve('permission-denied');
  await Promise.all([launch, foreground]);

  await attempt();
  await attempt();
  expect(register).toHaveBeenCalledTimes(2);
});
