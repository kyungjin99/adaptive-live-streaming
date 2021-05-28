const express = require('express');
const fs = require('fs');
const util = require('util');

const router = express.Router();
const readdir = util.promisify(fs.readdir);

/* GET home page. */
router.get('/', async (req, res, next) => {
  const urls = [];
  let ids;
  try {
    const dirList = await readdir('live');
    for (const dirname of dirList) {
      urls.push(`live/${dirname}`);
    }
    ids = dirList;
  } catch (error) {
    console.log('index router error');
    console.log(error);
  } finally {
    console.log(urls);
    res.render('index', { urls, ids });
  }
});

router.get('/live/:id', (req, res, next) => {
  const id = req.params.id;
  const url = `/${id}`;
  console.log(`id = ${id}`);
  console.log(`url = ${url}`);
  res.render('streaming', { id, url });
});

module.exports = router;
