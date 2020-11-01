/* eslint-disable @typescript-eslint/no-use-before-define */
import { AllCardsService, GameFormat } from '@firestone-hs/reference-data';
import { DeckDefinition, decode, encode } from 'deckstrings';
import { getConnection } from './db/rds';
import { S3 } from './db/s3';
// import { fetch } from 'node-fetch';
// import { Rds } from './db/rds';
import { ReviewMessage } from './review-message';
import { DeckStat } from './stat';
import { formatDate, toCreationDate } from './utils/util-functions';

const s3 = new S3();
const cards = new AllCardsService();

export class ReviewHandler {
	public async handle(messages: readonly ReviewMessage[]) {
		return await Promise.all(messages.map(msg => this.buildStat(msg)));
	}

	private async buildStat(message: ReviewMessage) {
		console.log('processing', message);
		const runId = message.currentDuelsRunId;
		if (!runId) {
			console.error('runId empty', message);
			return;
		}

		const mysql = await getConnection();
		const lootQuery = `
			SELECT bundleType, 
			CASE  
				WHEN chosenOptionIndex = 1 THEN option1 
				WHEN chosenOptionIndex = 2 THEN option2  
				ELSE option3 END as pickedTreasure 
			FROM dungeon_run_loot_info
			WHERE runId = '${runId}'
			AND bundleType IN ('treasure', 'hero-power', 'signature-treasure') 
		`;
		console.log('running query', lootQuery);
		const lootResults: readonly any[] = await mysql.query(lootQuery);
		console.log('loot results', lootResults);

		const query = `
			SELECT x1.creationDate, x1.playerClass, x1.playerCardId, x1.playerRank, x1.playerDecklist
			FROM replay_summary x1 
			INNER JOIN match_stats x3 ON x3.reviewId = x1.reviewId
			WHERE x3.statValue = '${runId}'
			AND x1.playerDecklist IS NOT null 
			AND x1.additionalResult = '0-0'
		`;
		console.log('running query', query);
		const decksResults: readonly any[] = await mysql.query(query);
		console.log('decksResult');

		if (!lootResults || lootResults.length === 0 || !decksResults || decksResults.length === 0) {
			console.log('run info not present');
			return;
		}

		const heroPowerNodes = lootResults.filter(result => result.bundleType === 'hero-power');
		if (heroPowerNodes.length !== 1 || decksResults.length !== 1) {
			console.log('runs have been mixed up', heroPowerNodes, decksResults);
			return;
		}

		const heroPowerNode = heroPowerNodes[0];
		const firstGameInRun = decksResults[0];
		const finalDecklist = message.playerDecklist;
		const [wins, losses] = message.additionalResult.split('-').map(info => parseInt(info));
		if (wins !== 11) {
			console.error('invalid number of wins', message.additionalResult);
		}
		const periodDate = formatDate(new Date());

		await cards.initializeCardsDb();
		const decklist = cleanDecklist(firstGameInRun.playerDecklist, firstGameInRun.playerCardId, cards);
		if (!decklist) {
			console.log('invalid decklist', firstGameInRun.playerDecklist, firstGameInRun);
			return null;
		}
		const stat = {
			periodStart: periodDate,
			playerClass: firstGameInRun.playerClass,
			finalDecklist: finalDecklist,
			decklist: decklist,
			heroCardId: message.playerCardId,
			heroPowerCardId: heroPowerNode.pickedTreasure,
			signatureTreasureCardId: findSignatureTreasureCardId(lootResults, heroPowerNode.runId),
			treasuresCardIds: findTreasuresCardIds(lootResults, heroPowerNode.runId),
			runId: runId,
			wins: wins + 1,
			losses: losses,
			rating: firstGameInRun.playerRank,
			runStartDate: toCreationDate(firstGameInRun.creationDate),
		} as DeckStat;
		const insertQuery = `
			INSERT INTO duels_stats_deck 
			(periodStart, playerClass, decklist, finalDecklist, heroCardId, heroPowerCardId, signatureTreasureCardId, treasuresCardIds, runId, wins, losses, rating, runStartDate)
			VALUES 
			(
				'${stat.periodStart}', 
				'${stat.playerClass}', 
				'${stat.decklist}', 
				'${stat.finalDecklist}', 
				'${stat.heroCardId}', 
				'${stat.heroPowerCardId}', 
				'${stat.signatureTreasureCardId}', 
				'${stat.treasuresCardIds.join(',')}', 
				'${stat.runId}', 
				${stat.wins}, 
				${stat.losses}, 
				${stat.rating}, 
				'${stat.runStartDate}'
			)
		`;
		console.log('running query', insertQuery);
		await mysql.query(insertQuery);
	}
}

const cleanDecklist = (initialDecklist: string, playerCardId: string, cards: AllCardsService): string => {
	console.log('cleaning decklist', initialDecklist);
	const decoded = decode(initialDecklist);
	console.log('decoded', decoded);
	const validCards = decoded.cards.filter(dbfCardId => cards.getCardFromDbfId(dbfCardId[0]).collectible);
	if (validCards.length !== 15) {
		console.error('Invalid deck list', initialDecklist, decoded);
		return null;
	}
	console.log('valid cards', validCards);
	const hero = getHero(playerCardId, cards);
	console.log('hero', playerCardId, hero);
	const newDeck: DeckDefinition = {
		cards: validCards,
		heroes: !hero ? decoded.heroes : [hero],
		format: GameFormat.FT_WILD,
	};
	console.log('new deck', newDeck);
	const newDeckstring = encode(newDeck);
	console.log('new deckstring', newDeckstring);
	return newDeckstring;
};

const getHero = (playerCardId: string, cards: AllCardsService): number => {
	const playerClass = cards.getCard(playerCardId)?.playerClass;
	switch (playerClass) {
		case 'DemonHunter':
			return 56550;
		case 'Druid':
			return 274;
		case 'Hunter':
			return 31;
		case 'Mage':
			return 637;
		case 'Paladin':
			return 671;
		case 'Priest':
			return 813;
		case 'Rogue':
			return 930;
		case 'Shaman':
			return 1066;
		case 'Warlock':
			return 893;
		case 'Warrior':
		default:
			return 7;
	}
};

const findSignatureTreasureCardId = (decksResults: readonly any[], runId: string): string => {
	const sigs = decksResults
		.filter(result => result.runId === runId)
		.filter(result => result.bundleType === 'signature-treasure');
	return sigs.length === 0 ? null : sigs[0].pickedTreasure;
};

const findTreasuresCardIds = (decksResults: readonly any[], runId: string): readonly string[] => {
	return decksResults
		.filter(result => result.runId === runId)
		.filter(result => result.bundleType === 'treasure')
		.map(result => result.pickedTreasure);
};
