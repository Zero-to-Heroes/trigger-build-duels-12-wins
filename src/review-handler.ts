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
		console.log('handling message', message);
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
		const lootResults: readonly any[] = await mysql.query(lootQuery);

		const query = `
			SELECT x1.creationDate, x1.playerClass, x1.playerCardId, x1.playerRank, x1.playerDecklist, x1.additionalResult
			FROM replay_summary x1 
			WHERE x1.runId = '${runId}'
			AND x1.playerDecklist IS NOT null 
		`;
		const allDecksResults: readonly any[] = await mysql.query(query);

		// Discard the info if multiple classes are in the same run
		const uniqueHeroes = [...new Set(allDecksResults.map(result => result.playerCardId))];
		if (uniqueHeroes.length !== 1) {
			console.error('corrupted run', runId, uniqueHeroes);
			return;
		}

		const firstGameResult = allDecksResults.filter(result => result.additionalResult === '0-0');
		if (!lootResults || lootResults.length === 0 || !firstGameResult || firstGameResult.length === 0) {
			return;
		}

		const heroPowerNodes = lootResults.filter(result => result.bundleType === 'hero-power');
		if (heroPowerNodes.length !== 1 || firstGameResult.length !== 1) {
			return;
		}

		const heroPowerNode = heroPowerNodes[0];
		const finalDecklist = message.playerDecklist;
		const [wins, losses] = message.additionalResult.split('-').map(info => parseInt(info));
		if (wins < 10) {
			console.error('invalid number of wins', message.additionalResult);
			return null;
		}

		const firstGameInRun = firstGameResult[0];
		const periodDate = formatDate(new Date());
		await cards.initializeCardsDb();
		const decklist = cleanDecklist(firstGameInRun.playerDecklist, firstGameInRun.playerCardId, cards);
		if (!decklist) {
			return null;
		}

		const rating = allDecksResults.find(result => result.playerRank != null)?.playerRank;
		console.log('rating', rating, allDecksResults);
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
			wins: wins + (message.result === 'won' ? 1 : 0),
			losses: losses + (message.result === 'lost' ? 1 : 0),
			rating: rating,
			runStartDate: toCreationDate(firstGameInRun.creationDate),
		} as DeckStat;

		const insertQuery = `
			INSERT INTO duels_stats_deck 
			(gameMode, periodStart, playerClass, decklist, finalDecklist, heroCardId, heroPowerCardId, signatureTreasureCardId, treasuresCardIds, runId, wins, losses, rating, runStartDate)
			VALUES 
			(
				'${message.gameMode}',
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
		await mysql.query(insertQuery);
		await mysql.end();
	}
}

const cleanDecklist = (initialDecklist: string, playerCardId: string, cards: AllCardsService): string => {
	const decoded = decode(initialDecklist);
	const validCards = decoded.cards.filter(dbfCardId => cards.getCardFromDbfId(dbfCardId[0]).collectible);
	if (validCards.length !== 15) {
		console.error('Invalid deck list', initialDecklist, decoded);
		return null;
	}
	const hero = getHero(playerCardId, cards);
	const newDeck: DeckDefinition = {
		cards: validCards,
		heroes: !hero ? decoded.heroes : [hero],
		format: GameFormat.FT_WILD,
	};
	const newDeckstring = encode(newDeck);
	return newDeckstring;
};

const getHero = (playerCardId: string, cards: AllCardsService): number => {
	const playerClass: string = cards.getCard(playerCardId)?.playerClass;
	switch (playerClass) {
		case 'DemonHunter':
		case 'Demonhunter':
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
