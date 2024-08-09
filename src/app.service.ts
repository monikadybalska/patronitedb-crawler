import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import axios from 'axios';
import { InfluxDB, Point } from '@influxdata/influxdb-client';
import { env } from 'process';
import { parseNumber } from './lib/utils';
import { Cron } from '@nestjs/schedule';

const PATRONITE_URL = 'https://patronite.pl/';

const error = 'Page not found';

export interface Author {
  url: string;
  name: string;
  image_url: string;
  is_recommended: 'true' | 'false';
  monthly_revenue: number;
  number_of_patrons: number;
  total_revenue: number;
  tags: string;
}

@Injectable()
export class AppService {
  authors: Map<string, Author>;

  constructor() {
    this.authors = new Map();
  }

  @Cron('10 12 * * * ')
  handleCron() {
    return this.writeToInfluxDB();
  }

  private async getPage(path: string) {
    while (true) {
      try {
        const response = await axios.get(`${PATRONITE_URL}${path}`, {
          timeout: 5000,
        });
        const html = response.data;
        return cheerio.load(html);
      } catch (e) {
        console.log(e);
        if (e.response === undefined) {
          await new Promise((r) => setTimeout(r, 10000));
        } else if (e.response.status === 429) {
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          return error;
        }
      }
    }
  }

  private async getCategories() {
    const $ = await this.getPage('/kategoria/47/polityka');
    if ($ === error) {
      return error;
    } else {
      const categories = [];
      const categoryLinks = $('div.tags a');
      let currentItem = $('div.tags div:first');
      for (let i = 0; i < categoryLinks.length; i++) {
        categories.push(currentItem.find('a').attr('href').slice(21));
        currentItem = currentItem.next();
      }
      return categories;
    }
  }

  private getAuthor({
    currentItem,
    is_recommended,
  }: {
    currentItem: cheerio.Cheerio<cheerio.Element>;
    is_recommended: boolean;
  }) {
    const author: Author = {
      url: currentItem.find('a.author__card').attr('href'),
      name: currentItem.find('div.card__content--name h5').text(),
      image_url: currentItem.find('img').attr('data-src'),
      is_recommended: `${is_recommended}`,
      number_of_patrons: parseNumber(
        currentItem
          .find('div.card__content--numbers div:contains("patron") span:first')
          .text(),
      ),
      monthly_revenue: parseNumber(
        currentItem
          .find(
            'div.card__content--numbers div:contains("miesięcznie") span:first',
          )
          .text(),
      ),
      total_revenue: parseNumber(
        currentItem
          .find('div.card__content--numbers div:contains("łącznie") span:first')
          .text(),
      ),
      tags: (function () {
        const tagsArray: string[] = [];
        const tags = currentItem.find('div.card__content--tags span');
        let currentTag = currentItem.find('div.card__content--tags span:first');
        for (let i = 0; i < tags.length; i++) {
          tagsArray.push(currentTag.text());
          currentTag = currentTag.next();
        }
        return tagsArray.join(',');
      })(),
    };
    return author;
  }

  private getAuthors({
    itemList,
    currentItem,
    is_recommended,
  }: {
    itemList: cheerio.Cheerio<cheerio.Element>;
    currentItem: cheerio.Cheerio<cheerio.Element>;
    is_recommended: boolean;
  }) {
    const authors: Author[] = [];
    for (let i = 0; i < itemList.length; i++) {
      authors.push(
        this.getAuthor({ currentItem, is_recommended: is_recommended }),
      );
      currentItem = currentItem.next();
    }
    return authors;
  }

  private async getAuthorsByPage(path: string, pageNumber: number) {
    const url = `/${path}?page=${pageNumber}`;
    console.log(url);
    const $ = await this.getPage(url);
    const authors: Author[] = [];

    if ($ === error) {
      return error;
    }

    let authorList = $('div.author__list div.carousel-cell');
    let currentAuthor = $('div.author__list div.carousel-cell:first');

    if (pageNumber === 1) {
      const recommendedAuthorsContainer = $('h4:contains("Nasz wybór")')
        .parent()
        .parent();
      const recommendedAuthorList = recommendedAuthorsContainer.find(
        'div.author__list div.carousel-cell',
      );
      const currentRecommendedAuthor = recommendedAuthorsContainer.find(
        'div.author__list div.carousel-cell:first',
      );

      const recommendedAuthors = this.getAuthors({
        itemList: recommendedAuthorList,
        currentItem: currentRecommendedAuthor,
        is_recommended: true,
      });

      authors.push(...recommendedAuthors);
    }

    const allAuthorsContainer = $('h4:contains("Wszyscy")').parent().parent();
    authorList = allAuthorsContainer.find('div.author__list div.carousel-cell');
    currentAuthor = allAuthorsContainer.find(
      'div.author__list div.carousel-cell:first',
    );

    const allAuthors = this.getAuthors({
      itemList: authorList,
      currentItem: currentAuthor,
      is_recommended: false,
    });

    authors.push(...allAuthors);

    return authors;
  }

  private async getAuthorsByCategory(category: string) {
    let currentPage = 1;
    const allPages: Author[] = [];

    console.log(`Retrieving ${category}`);
    while (true) {
      if (currentPage % 10 == 0) {
        console.log(`${category}: page ${currentPage}`);
      }
      const response = await this.getAuthorsByPage(category, currentPage);
      if (response === error) {
        console.log(`${category}: finished at page ${currentPage}`);
        break;
      } else {
        allPages.push(...response);
        currentPage++;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    return allPages;
  }

  private async getAllAuthors() {
    const categories = await this.getCategories();
    const categoryPromises: Promise<Author[]>[] = [];

    if (categories === error) {
      return error;
    }

    for (const category of categories) {
      categoryPromises.push(this.getAuthorsByCategory(category));
    }

    return await Promise.all(categoryPromises).then((values) => {
      const authorsMap: Map<string, Author> = new Map();
      const authorsArray = values.flat();
      authorsArray.forEach((author) => {
        if (!authorsMap.has(author.url) || author.is_recommended === 'true') {
          authorsMap.set(author.url, author);
        }
      });
      return authorsMap;
    });
  }

  async writeToInfluxDB() {
    const influxDB = new InfluxDB({
      url: env.INFLUX_URL,
      token: env.INFLUX_TOKEN,
    });
    const writeApi = influxDB.getWriteApi(env.INFLUX_ORG, env.INFLUX_BUCKET);
    writeApi.useDefaultTags({ region: 'eu-central' });

    const authorsMap = await this.getAllAuthors();

    if (authorsMap === error) {
      return error;
    }

    for (const author of authorsMap.values()) {
      const point = new Point('creators')
        .timestamp(new Date())
        .tag('url', author.url)
        .tag('name', author.name)
        .tag('image_url', author.image_url)
        .tag('is_recommended', author.is_recommended)
        .tag('tags', author.tags)
        .tag('source', 'node.js')
        .intField('monthly_revenue', author.monthly_revenue)
        .intField('number_of_patrons', author.number_of_patrons)
        .intField('total_revenue', author.total_revenue);

      writeApi.writePoint(point);
    }

    writeApi.close().then(() => {
      console.log('Write finished');
    });
  }
}
