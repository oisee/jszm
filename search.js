"use strict";

const G=require("genasync"); // A package I wrote
const JSZM=require("./jszm.js"); // version 2
const readline=require("readline");
const fs=require("fs");

const In=readline.createInterface({input: process.stdin});
const Out=process.stdout;

G.defineER(fs,"readFile","readFileG",2);
G.defineER(fs,"writeFile","writeFileG",3);
G.defineR(In,"question","questionG",1);

class DeadError extends Error { }

G.run((function*() {
  var story=yield fs.readFileG(process.argv[2],{});
  var game=new JSZM(story);
  var words;
  var turncmd = '__START__';
  var turnscore = 0;
  var turnmods = 0;
  var turntoks = {};
  var allcmdstats = {};
  var alltoks = {};
  var priors = new Map();
  var playtoks;
  var playcmds;
  var ignorecmds = JSON.parse(fs.readFileSync('ignorecmds.json'));
  var rankedcmds;
  
  function logtoken(token) {
    turntoks[token] = 1;
  }
  function sortcmds() {
    rankedcmds = []
    for (var cmd in allcmdstats) {
      rankedcmds.push(allcmdstats[cmd]);
    }
    rankedcmds.sort((a,b) => { return b.score-a.score });
    playtoks = new Set();
    playcmds = []
  }
  function getrandomcmd() {
    do {
      var s = "";
      for (var i=0; i<2; i++) {
        if (i>0) s += " ";
        s += words[Math.floor(Math.random() * words.length)];
        if (Math.random() < 0.5) break;
      }
    } while (ignorecmds[s]);
    return s;
  }
  function addpriors(b, cmd) {
    // only consider underscore tokens (for now)
    if (!b.startsWith('mv_') && !b.startsWith('fs_') && !b.startsWith('fc_')) return;
    // try to find prior tokens in this playthrough that always pop up with (cmd, b)
    var cmd_b = [cmd, b];
    var p = priors[cmd_b];
    if (!p) {
      // fill out list with this playthrough
      p = new Set(playtoks);
    } else {
      // intersect with tokens in this playthrough
      p = new Set([...p].filter(x => playtoks.has(x)));
    }
    console.log(cmd_b, p.size);
    priors[cmd_b] = p;
  }
  function committurn(rew) {
    playcmds.push(turncmd);
    // find new tokens for this playthrough
    for (var token in turntoks) {
      if (!playtoks[token]) {
        addpriors(token, turncmd);
      }
    }
    for (var token in turntoks) {
      playtoks.add(token);
    }
    
    if (turnmods == 0) {
      ignorecmds[turncmd] = 1;
    } else {
      var thiscmdstats = allcmdstats[turncmd];
      // only on second time running command...
      if (thiscmdstats) {
        for (var token in turntoks) {
          // new token?
          if (!alltoks[token]) {
            turnscore += 1;
          }
          alltoks[token] = (alltoks[token] | 0) + 1;
          console.log(token, alltoks[token]);
          // new token for this cmd?
          if (!thiscmdstats.toks[token]) {
            thiscmdstats.toks[token] = 1;
            turnscore += 1;
          }
        }
        thiscmdstats.score += turnscore;
        console.log(turncmd,'+',turnscore,'=',thiscmdstats.score);
      } else {
        allcmdstats[turncmd] = {cmd:turncmd,toks:turntoks,score:0};
      }
    }
    turntoks = {};
    turnscore = 0;
    turnmods = 0;
  }
  game.log = (a,b,c) => {
    logtoken(a+"_"+b+"_"+c);
    turnmods += 1;
    //console.log(a,b,c)
  }
  function log(token,reward) {
    var rec = thisplay[token];
    if (!rec) {
      rec = {n:0,d:0};
      thisplay[token] = rec;
    }
    rec.n += reward;
    rec.d += 1;
  }
  game.print=function*(x) {
    if (/RESTART, RESTORE, or QUIT/.exec(x)) {
      committurn(-1);
      throw new DeadError();
    }
    for (var tok of x.split(/\s+/)) {
      if (tok.length >= 3) logtoken(tok);
    }
    Out.write(x,"ascii");
  };
  game.read=function*() {
    committurn(1);
    if (!words) {
      var keys = game.vocabulary.keys();
      words=Array.from(keys).filter((s) => { return /^\w/.exec(s) });
      words=words.filter((s) => { return !/^(restor|restar|save|q|quit)$/.exec(s) });
    }
    // get next command
    if (rankedcmds.length && Math.random() < 0.5) {
      var i = Math.floor(Math.pow(Math.random(), 4) * rankedcmds.length);
      turncmd = rankedcmds[i].cmd;
      console.log(turncmd, '-> score', rankedcmds[i].score, '#', i);
    } else {
      turncmd = getrandomcmd();
      console.log(turncmd);
    }
    return turncmd;
    //return yield In.questionG("");
  };
  game.save=function*(x) {
    var n,e;
    Out.write("Save? ","ascii");
    n=yield In.questionG("");
    if(!n) return false;
    try {
      yield fs.writeFileG(n,new Buffer(x.buffer),{});
      return true;
    } catch(e) {
      return false;
    }
  };
  game.restore=function*() {
    var n,e;
    Out.write("Restore? ","ascii");
    n=yield In.questionG("");
    if(!n) return null;
    try {
      return new Uint8Array(yield fs.readFileG(n,{}));
    } catch(e) {
      return null;
    }
  };
  while (1) {
    try {
      sortcmds();
      yield*game.run();
    } catch(e) {
      if (e instanceof DeadError) {
        console.log(turncmd,'killed you');
        delete allcmdstats[turncmd]; // TODO?
        console.log("this playthrough had", Object.keys(playtoks).length/playcmds.length, "tokens per command");
        if (0) {
          fs.writeFileSync('ignorecmds.json.tmp',JSON.stringify(ignorecmds));
          fs.renameSync('ignorecmds.json.tmp', 'ignorecmds.json');
        }
      } else
        throw e;
    }
  }
  process.exit(0);
})());
