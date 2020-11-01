import { ReviewHandler } from './review-handler';
import { ReviewMessage } from './review-message';

// This example demonstrates a NodeJS 8.10 async handler[1], however of course you could use
// the more traditional callback-style handler.
// [1]: https://aws.amazon.com/blogs/compute/node-js-8-10-runtime-now-available-in-aws-lambda/
export default async (event): Promise<any> => {
	// console.log('event', JSON.stringify(event));
	const messages: readonly ReviewMessage[] = event.Records.map(record => record.Sns.Message).map(msg =>
		JSON.parse(msg),
	);
	// console.log('input', JSON.stringify(messages));
	await new ReviewHandler().handle(messages);
	// console.log('built stats', JSON.stringify(stats));
	return { statusCode: 200, body: null };
};
