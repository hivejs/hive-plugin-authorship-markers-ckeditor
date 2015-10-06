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
module.exports.consumes = ['ui', 'editor', 'models','hooks']
function setup(plugin, imports, register) {
  var ui = imports.ui
  , hooks = imports.hooks
  , Backbone = imports.models.Backbone

  var link = document.createElement('link')
  link.setAttribute('rel', 'stylesheet')
  link.setAttribute('href', ui.baseURL+'/static/hive-plugin-ckeditor-authorship-markers/css/index.css')
  document.head.appendChild(link)

  ui.page('/documents/:id', function(ctx, next) {
    // This plugin works with the default html editor only
    if(ctx.document.get('type') !== 'html') return next()

    var cke_inner = document.querySelector('#editor .cke_inner')
      , tree = h('div.AuthorshipMarkers')
      , container = vdom.create(tree)
      , authors = new (Backbone.Collection.extend({model: ctx.models.user}))()
      , sections

    cke_inner.insertBefore(container, cke_inner.childNodes[1])

    // when the document has been initialized...
    ctx.editableDocument.on('init', function() {
      setTimeout(function() {
        co(function*() {
          // ... collect attributions and render the markers
          sections = yield collectAttributions()
          render(sections)
        }).then(function() {}, function(er) {throw er})
      }, 0)
    })

    // If this user makes changes...
    ctx.editableDocument.on('update', function(edit) {
      setTimeout(function() {
        // ...attribute the changes to them
        edit.changeset.forEach(function(op) {
          var path
          if(op.path) path = op.path
          if(op.to) path = op.to
          if(!path) return
          var node = nodeAt(path, ctx.editableDocument.rootNode)
          if(op.to && !op.from) resetAuthorsOfNode(node)
          addAuthorToNode(node, ctx.user.get('id'))
        })
        co(function*() {
          // ... re-collect attributions and re-render the markers
          sections = yield collectAttributions()
          render(sections)
        }).then(function() {}, function(er) {throw er})
      }, 0)
    })

    // If someone else makes changes...
    ctx.editableDocument.on('edit', function() {
      co(function*() {
        // re-collect attributions and re-render the markers as well
        sections = yield collectAttributions()
        render(sections)
      }).then(function() {}, function(er) {throw er})
    })

    // If the main editor window is scrolled, scroll the markers, too
    var editorWindow = ctx.editableDocument.rootNode.ownerDocument.defaultView
    editorWindow.onscroll = function() {
      container.scrollTop = editorWindow.scrollY
    }

    // If a color changes only re-render the markers
    authors.on('change:color', function(){
      render(sections)
    })

    function* collectAttributions() {
      // Extract authorship sections from the document
      var sections = seekAuthors(ctx.editableDocument.rootNode)

      // sort thesee section by author
      var sectionsByAuthor = sortByAuthors(sections)

      // load any unknown author/user objects
      yield Object.keys(sectionsByAuthor)
      .map(function*(authorId) {
        if(authorId == ctx.user.get('id')) return authors.add(ctx.user)
        if(authors.get(authorId)) return
        var author = new ctx.models.user({id: authorId})
        yield function(cb) {
          author.fetch({
            success: function(){cb()}
          , error: function(m, resp){cb(new Error('Server returned '+resp.status))}
          })
        }

        authors.add(author)
        setInterval(function() {
          author.fetch()
        }, 10000)
      })

      return sectionsByAuthor
    }

    function render(sectionsByAuthor) {
      // Visualize authorship by drawing lines for each author
      var newtree = h('div.AuthorshipMarkers', Object.keys(sectionsByAuthor).map(function(author) {
        return h('div.AuthorshipMarkers__Section'
        , sectionsByAuthor[author].map(function(section) {
            return h('div.AuthorshipMarkers__Marker', {style: {
                'border-color': authors.get(author).get('color') || '#777'
              , 'height': section.height+'px'
              , 'top': section.y+'px'
              }
            })
          })
        )
      }))

      // Construct the diff between the new and the old drawing and update the live dom tree
      var patches = vdom.diff(tree, newtree)
      vdom.patch(container, patches)
      tree = newtree
      container.scrollTop = editorWindow.scrollY
    }

    hooks.on('plugin-presence:renderUser', function*(user, props, children) {
      var style = props.style || (props.style = {})
        , color = user.get('color') || '#777'
      style['border-color'] = color
      var input = h('input.btn.btn-default',
        {attributes: {type: 'color', value: color}
      , 'ev-change': function(evt) {
          user.set('color', evt.currentTarget.value)
          user.save()
        }
      })
      if(user.get('id') == ctx.user.get('id')) children.push(input)
    })

    next()
  })

  register()
}

function seekAuthors(el, data) {
  if(!data) data = []
  for(var i=0; i<el.children.length; i++) {
    var node = el.children[i]
      , authors = getAuthorsOfNode(node)
      , boundingRect = node.getBoundingClientRect()
    var obj = {
      y: boundingRect.top+node.ownerDocument.defaultView.scrollY
    , height: boundingRect.height
    , authors: authors
    }
    data.push(obj)
    seekAuthors(node, data)
  }
  return data
}
function sortByAuthors(sections) {
  var sectionsByAuthor = {}
  sections.forEach(function(section) {
    Object.keys(section.authors).forEach(function(author) {
      if(!sectionsByAuthor[author]) sectionsByAuthor[author] = []
      sectionsByAuthor[author].push({y: section.y, height: section.height})
    })
  })
  return sectionsByAuthor
}

function addAuthorToNode(node, userId) {
  if(!(node instanceof Element)) node = node.parentNode
  var authors = getAuthorsOfNode(node)

  authors[userId] = true

  node.setAttribute('data-author', Object.keys(authors).join(' '))
}

function resetAuthorsOfNode(node) {
  if(node instanceof Element) {
    node.setAttribute('data-author', '')
  }
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
