/**
 * hive.js
 * Copyright (C) 2013-2015 Marcel Klehr <mklehr@gmx.net>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 *  along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

var vdom = require('virtual-dom')
  , h = vdom.h
  , nodeAt = require('dom-ot/lib/ops/node-at')
  , co = require('co')

module.exports = setup
module.exports.consumes = ['ui', 'editor']
function setup(plugin, imports, register) {
  var ui = imports.ui

  var link = document.createElement('link')
  link.setAttribute('rel', 'stylesheet')
  link.setAttribute('href', 'static/hive-plugin-html-authorship-markers/css/index.css')
  document.head.appendChild(link)

  ui.page('/:id',
  function loadClient(ctx, next) {
    if(ctx.document.type !== 'html') return next()
    
    var cke_inner = document.querySelector('#editor .cke_inner')
      , tree = h('div.AuthorshipMarkers')
      , container = vdom.create(tree)
    
    cke_inner.insertBefore(container, cke_inner.childNodes[1])
    
    ctx.editableDocument.on('update', function(edit) {
      setTimeout(function() {
        edit.changeset.forEach(function(op) {
          var path
          if(op.path) path = op.path
          if(op.to) path = op.to
          if(!path) return
          var node = nodeAt(path, ctx.editableDocument.rootNode)
          addAuthorToNode(node, ctx.user.id)
        })
        co(function*() {
          yield render()
        }).then(function() {}, function(er) {throw er})
      }, 0)
    })
    
    ctx.editableDocument.on('edit', function() {
      co(function*() {
        yield render()
      }).then(function() {}, function(er) {throw er})
    })
    
    var editorWindow = ctx.editableDocument.rootNode.ownerDocument.defaultView
    editorWindow.onscroll = function() {
      container.scrollTop = editorWindow.scrollY
    }
    
    function* render() {
      var data = []
      seekAuthors(ctx.editableDocument.rootNode, data)

      var newtree = h('div.AuthorshipMarkers', yield data.map(function*(section) {
        return h('div.AuthorshipMarkers__Section'
        , {style: {height: section.height+'px', top: section.y+'px'}}
        , yield Object.keys(section.authors).map(function*(author) {
            author = yield function(cb) {
              ctx.client.user.get(author, cb)
            }
            return h('div.AuthorshipMarkers__Marker', {style: {'border-left': '2px solid '+(author.color || '#777')}})
          })
        )
      }))
      
      var patches = vdom.diff(tree, newtree)
      vdom.patch(container, patches)
      tree = newtree
      container.scrollTop = editorWindow.scrollY
    }
    
    next()
  })

  register()
}

function seekAuthors(el, data) {
  for(var i=0; i<el.children.length; i++) {
    var node = el.children[i]
      , authors = getAuthorsOfNode(node)
      , boundingRect = node.getBoundingClientRect()
    var obj = {
      y: boundingRect.y+node.ownerDocument.defaultView.scrollY
    , height: boundingRect.height
    , authors: authors
    }
    data.push(obj)
    seekAuthors(node, data)
  }
}
/*
function flattenAuthorData(data) {
  var flattened = []

  var sorted = data
  .sort(function(obj1, obj2) {
    return obj1.y >= obj2.y ? 1 : -1
  })
  sorted
  .forEach(function(obj) {
    var intersecting = sorted.filter(intersect.bind(null, obj))
    var currentY = 0
    intersecting.forEach(function(intersectingObj) {
      var newobj
      if(intersectingObj.y > obj.y) {
        var newobj = {
          y: obj.y,
        , height: intersectingObj.height - (obj.y - intersectingObj.y)
        , authors: mergeAuthors(intersectingObj.authors, obj.authors)
        }
        flattened.push(newobj)
        intersectingObj.flattened = true
        currentY += newobj.height
      }else
      if(intersectingObj.y+intersectingObj.height < obj.y) {
      
      }
    })
  })
  
  function intersect(obj1, obj2) {
    // obj1 is below obj2
    if(obj1.y > obj2.y+obj2.height) return false
    // obj2 is below obj1
    if(obj2.y > obj1.y+obj1.height) return false

    return true
  }
}

function mergeAuthors(au1, au2) {
  var obj = {}
  for(var author in au1) {
    obj[author] = true
  }
  for(var author in au2) {
    obj[author] = true
  }
  return obj
}*/

function addAuthorToNode(node, userId) {
  if(!(node instanceof Element)) node = node.parentNode
  var authors = getAuthorsOfNode(node)
  
  authors[userId] = true
  
  node.setAttribute('data-author', Object.keys(authors).join(' '))
}

function getAuthorsOfNode(node) {
  var authorstring = node.getAttribute('data-author')
    , authors
  if(!authorstring) authors = {}
  else authors = parseAuthors(authorstring)
  
  return authors
}

function parseAuthors(authorString) {
  var authors = {}
  authorString
  .split(' ')
  .forEach(function(authorId) {
    authors[authorId] = true
  })
  
  return authors
}